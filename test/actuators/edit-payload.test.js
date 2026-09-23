import { Decimal128, Long, MongoClient, ObjectId } from "mongodb";
import { env } from "node:process";
import { setTimeout } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  editInboxPayload,
  editOutboxPayload,
  getInboxEvent,
  getOutboxEvent,
  purgeInboxEvent,
  redriveInboxEvent,
  redriveOutboxEvent,
} from "../helpers/actuators.js";

let client;
let db;
let inbox;
let outbox;

const UNKNOWN_ID = "665f1c2e9a1b2c3d4e5f6aaa";
const MAX_RETRIES = 5;
const PAYLOAD_MAX_BYTES = 256 * 1024;

// Values that must never reach the audit event: an applicant's name in the
// payload, and whoever the operator's note mentions.
const NAME = "Ada Lovelace";
const NOTE = "amount was sent as a string - checked with Grace Hopper";

const bodyOf = (error) => {
  const payload = error.data?.payload;

  return Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload;
};

const statusOf = (error) => error.output.statusCode;

const refusalOf = async (request) => {
  const error = await request.catch((e) => e);

  return { status: statusOf(error), body: bodyOf(error) };
};

const auditsFor = (doc) =>
  outbox
    .find({
      "event.audit.entities.entityid": doc._id.toHexString(),
      "event.audit.entities.action": "EDIT_EVENT_PAYLOAD",
    })
    .toArray();

const STORED_EVENT = {
  id: "evt-1",
  type: "cloud.defra.test.fg-gas-backend.edit.test.unknown",
  time: "2026-06-16T10:00:00.000Z",
  data: { name: NAME, amount: "12" },
};

const anEditedEvent = (overrides = {}) => ({
  ...STORED_EVENT,
  data: { name: NAME, amount: 12 },
  ...overrides,
});

const aDeadInboxDoc = (overrides = {}) => ({
  _id: new ObjectId(),
  messageId: `msg-${new ObjectId().toHexString()}`,
  type: STORED_EVENT.type,
  source: "GAS",
  // unique, so the poller cannot claim it mid-test
  segregationRef: `EDIT-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  eventTime: STORED_EVENT.time,
  publicationDate: "2026-06-16T10:00:01.000Z",
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
  expireAt: null,
  lastError: { name: "TypeError", message: "boom", at: null },
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  event: STORED_EVENT,
  ...overrides,
});

const aDeadOutboxDoc = (overrides = {}) => ({
  _id: new ObjectId(),
  target: "arn:aws:sns:eu-west-2:000000000000:cw__sns__create_case_fifo.fifo",
  segregationRef: `EDIT-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  publicationDate: new Date("2026-06-16T10:00:00.000Z"),
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
  expireAt: null,
  lastError: null,
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  event: {
    id: "evt-2",
    type: "cloud.defra.test.fg-cw-backend.x",
    messageGroupId: "group-1",
    data: { name: NAME },
  },
  ...overrides,
});

const aStoredInbox = async (overrides) => {
  const doc = aDeadInboxDoc(overrides);
  await inbox.insertOne(doc);

  return doc;
};

const aStoredOutbox = async (overrides) => {
  const doc = aDeadOutboxDoc(overrides);
  await outbox.insertOne(doc);

  return doc;
};

const anEdit = (overrides = {}) => ({
  by: "donatas",
  payload: anEditedEvent(),
  note: NOTE,
  revision: 0,
  ...overrides,
});

const idOf = (doc) => doc._id.toHexString();

// Until the poller has handled the redriven row and saved it with its own
// `$set`: a failed attempt counts, a success completes it.
const isHandled = (row) =>
  row.completionAttempts > 0 || row.status === "COMPLETED";

const handledByThePoller = async (collection, doc, attempts = 40) => {
  const row = await collection.findOne({ _id: doc._id });

  if (isHandled(row)) {
    return row;
  }

  if (attempts === 0) {
    throw new Error(`The poller never handled ${idOf(doc)}`);
  }

  await setTimeout(250);

  return handledByThePoller(collection, doc, attempts - 1);
};

beforeAll(async () => {
  client = await MongoClient.connect(env.MONGO_URI);
  db = client.db();
  inbox = db.collection("inbox");
  outbox = db.collection("outbox");
});

afterAll(async () => {
  await client?.close(true);
});

describe("POST /actuators/events/inbox/{id}/payload", () => {
  it("rejects a request with no token", async () => {
    await expect(editInboxPayload(UNKNOWN_ID, anEdit(), null)).rejects.toThrow(
      "Response Error: 401 Unauthorized",
    );
  });

  it("rejects an id that is not a 24-hex ObjectId with 400", async () => {
    await expect(editInboxPayload("nope", anEdit())).rejects.toThrow(
      "Response Error: 400 Bad Request",
    );
  });

  it("404s for an id that does not exist", async () => {
    await expect(editInboxPayload(UNKNOWN_ID, anEdit())).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  it("answers 200 with the new revision and where the payload changed", async () => {
    const doc = await aStoredInbox();

    const { res, payload } = await editInboxPayload(idOf(doc), anEdit());

    expect(res.statusCode).toBe(200);
    expect(payload).toEqual({
      payloadRevision: 1,
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
    });
  });

  it("saves the payload, keeps the original and records the edit, leaving the status alone", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit());

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.status).toBe("DEAD_LETTER");
    expect(stored.event).toEqual(anEditedEvent());
    expect(stored.originalPayload).toEqual(STORED_EVENT);
    expect(stored.payloadRevision).toBe(1);
    expect(stored.lastEdit).toEqual({
      at: expect.any(String),
      by: "donatas",
      note: NOTE,
    });
    expect(stored.completionAttempts).toBe(MAX_RETRIES);
    expect(stored.lastError.message).toBe("boom");
  });

  it("edits a PURGED row and leaves it PURGED", async () => {
    const doc = await aStoredInbox();
    await purgeInboxEvent(idOf(doc), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
    });

    const { res } = await editInboxPayload(idOf(doc), anEdit({ revision: 1 }));

    expect(res.statusCode).toBe(200);
    expect((await inbox.findOne({ _id: doc._id })).status).toBe("PURGED");
  });

  it("re-derives the inbox type and eventTime from an edited envelope", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(
      idOf(doc),
      anEdit({
        payload: anEditedEvent({
          type: "cloud.defra.test.fg-gas-backend.case.update.status",
          time: "2026-06-17T09:00:00.000Z",
        }),
      }),
    );

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.type).toBe(
      "cloud.defra.test.fg-gas-backend.case.update.status",
    );
    expect(stored.eventTime).toBe("2026-06-17T09:00:00.000Z");
  });

  it("keeps the first edit's original through a second edit", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit());
    const { payload } = await editInboxPayload(
      idOf(doc),
      anEdit({
        payload: anEditedEvent({ data: { name: NAME, amount: 13 } }),
        note: "and again",
        revision: 1,
      }),
    );

    const stored = await inbox.findOne({ _id: doc._id });

    expect(payload.payloadRevision).toBe(2);
    expect(stored.payloadRevision).toBe(2);
    expect(stored.event.data.amount).toBe(13);
    expect(stored.originalPayload).toEqual(STORED_EVENT);
    expect(stored.lastEdit.note).toBe("and again");
  });
});

describe("the edit fence", () => {
  it("412s a save from a revision that is no longer current, writing nothing", async () => {
    const doc = await aStoredInbox();
    await editInboxPayload(idOf(doc), anEdit());

    const refusal = await refusalOf(
      editInboxPayload(
        idOf(doc),
        anEdit({ payload: anEditedEvent({ id: "evt-9" }), revision: 0 }),
      ),
    );

    const stored = await inbox.findOne({ _id: doc._id });

    expect(refusal.status).toBe(412);
    expect(stored.event.id).toBe("evt-1");
    expect(stored.payloadRevision).toBe(1);
  });

  it("412s an editor opened before a purge, and audits it as STALE", async () => {
    const doc = await aStoredInbox();
    await editInboxPayload(idOf(doc), anEdit());
    const { payload: opened } = await getInboxEvent(idOf(doc));
    await purgeInboxEvent(idOf(doc), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
    });

    const refusal = await refusalOf(
      editInboxPayload(
        idOf(doc),
        anEdit({
          payload: anEditedEvent({ id: "evt-9" }),
          revision: opened.payloadRevision,
        }),
      ),
    );
    const stored = await inbox.findOne({ _id: doc._id });
    const failure = (await auditsFor(doc)).find(
      (audit) => audit.event.audit.status === "FAILURE",
    );

    expect(refusal.status).toBe(412);
    expect(stored.status).toBe("PURGED");
    expect(stored.event.id).toBe("evt-1");
    expect(stored.payloadRevision).toBe(opened.payloadRevision + 1);
    expect(failure.event.audit.details.event).toMatchObject({
      revision: opened.payloadRevision,
      reason: "STALE",
    });
  });

  // The purge moved the revision on, but nobody had edited the row yet.
  it("keeps the original on the first edit of a purged row", async () => {
    const doc = await aStoredInbox();
    await purgeInboxEvent(idOf(doc), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
    });
    const { payload: opened } = await getInboxEvent(idOf(doc));

    await editInboxPayload(
      idOf(doc),
      anEdit({ revision: opened.payloadRevision }),
    );
    const stored = await inbox.findOne({ _id: doc._id });

    expect(opened.payloadRevision).toBe(1);
    expect(stored.payloadRevision).toBe(2);
    expect(stored.originalPayload).toEqual(STORED_EVENT);
  });

  // Should the row die again, an editor opened before the redrive is stale.
  it("moves the revision on when the row is redriven", async () => {
    const doc = await aStoredOutbox({ payloadRevision: 3 });

    await redriveOutboxEvent(idOf(doc), { by: "donatas" });

    expect((await outbox.findOne({ _id: doc._id })).payloadRevision).toBe(4);
  });

  it("412s a revision the row has not reached", async () => {
    const doc = await aStoredInbox();

    expect(
      (await refusalOf(editInboxPayload(idOf(doc), anEdit({ revision: 3 }))))
        .status,
    ).toBe(412);
  });

  it.each([
    ["COMPLETED", {}],
    [
      "PROCESSING",
      {
        completionAttempts: 0,
        claimedBy: "edit-test",
        claimedAt: new Date("2026-06-16T10:00:00.000Z"),
        claimExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    ],
  ])(
    "409s with the current status when the row is %s",
    async (status, overrides) => {
      const doc = await aStoredInbox({ status, ...overrides });

      const refusal = await refusalOf(editInboxPayload(idOf(doc), anEdit()));
      const stored = await inbox.findOne({ _id: doc._id });

      expect(refusal.status).toBe(409);
      expect(refusal.body.status).toBe(status);
      expect(refusal.body.message).toContain(
        "not editable (DEAD_LETTER or PURGED)",
      );
      expect(stored.event).toEqual(STORED_EVENT);
      expect(stored).not.toHaveProperty("lastEdit");
    },
  );
});

describe("edit refusals", () => {
  it("422s UNCHANGED when the payload is the stored one", async () => {
    const doc = await aStoredInbox();

    const refusal = await refusalOf(
      editInboxPayload(idOf(doc), anEdit({ payload: STORED_EVENT })),
    );

    expect(refusal.status).toBe(422);
    expect(refusal.body.reason).toBe("UNCHANGED");
  });

  it("422s DOLLAR_KEY for a key Mongo cannot store", async () => {
    const doc = await aStoredInbox();

    const refusal = await refusalOf(
      editInboxPayload(
        idOf(doc),
        anEdit({ payload: anEditedEvent({ data: { $where: "1" } }) }),
      ),
    );

    expect(refusal.status).toBe(422);
    expect(refusal.body.reason).toBe("DOLLAR_KEY");
  });

  // Compact it fits the body limit; pretty-printed it is over the bound.
  it("422s TOO_LARGE for a payload over 256 KiB pretty-printed", async () => {
    const doc = await aStoredInbox();
    const list = Array.from({ length: 50_000 }, () => 1);

    expect(JSON.stringify(list).length).toBeLessThan(PAYLOAD_MAX_BYTES);

    const refusal = await refusalOf(
      editInboxPayload(idOf(doc), anEdit({ payload: { list } })),
    );

    expect(refusal.status).toBe(422);
    expect(refusal.body.reason).toBe("TOO_LARGE");
  });

  it("413s a body far over the bound before reading it", async () => {
    const doc = await aStoredInbox();

    const refusal = await refusalOf(
      editInboxPayload(
        idOf(doc),
        anEdit({ payload: { x: "a".repeat(PAYLOAD_MAX_BYTES * 2) } }),
      ),
    );

    expect(refusal.status).toBe(413);
  });

  it.each([
    ["a payload that is an array", { payload: [] }],
    ["a missing note", { note: undefined }],
    ["a blank note", { note: "   " }],
    ["a note of 501 characters", { note: "x".repeat(501) }],
    ["a negative revision", { revision: -1 }],
    ["no operator", { by: undefined }],
  ])("400s %s", async (_, overrides) => {
    const doc = await aStoredInbox();

    const refusal = await refusalOf(
      editInboxPayload(idOf(doc), anEdit(overrides)),
    );

    expect(refusal.status).toBe(400);
    expect(JSON.stringify(refusal.body)).not.toContain(NAME);
  });

  it("400s a __proto__ key before anything reads it", async () => {
    const doc = await aStoredInbox();

    const refusal = await refusalOf(
      editInboxPayload(idOf(doc), {
        by: "donatas",
        payload: JSON.parse('{"id":"evt-1","__proto__":{"polluted":true}}'),
        note: NOTE,
        revision: 0,
      }),
    );

    expect(refusal.status).toBe(400);
  });

  it("leaves the row untouched after a refusal", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit({ payload: STORED_EVENT })).catch(
      () => {},
    );

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.event).toEqual(STORED_EVENT);
    expect(stored).not.toHaveProperty("payloadRevision");
    expect(stored).not.toHaveProperty("originalPayload");
  });
});

describe("the edit's audit event", () => {
  it("is written with the edited row, naming the paths and hashes", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit({ by: "ada" }));

    const [audit, ...others] = await auditsFor(doc);

    expect(others).toHaveLength(0);
    expect(audit.target).toMatch(/cw__sns__audit_topic_arn$/);
    expect(audit.segregationRef).toBe(`edit-event-${idOf(doc)}`);
    expect(audit.event.security.pmccode).toBe("0706");
    expect(audit.event.audit.status).toBe("SUCCESS");
    expect(audit.event.audit.entities[0]).toEqual({
      entity: "EVENT",
      action: "EDIT_EVENT_PAYLOAD",
      entityid: idOf(doc),
    });
    expect(audit.event.audit.details.event).toEqual({
      box: "inbox",
      actor: "ada",
      caller: "test-client",
      revision: 0,
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
      beforeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      afterHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("carries neither the note nor any payload value", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit());

    const [audit] = await auditsFor(doc);
    const serialised = JSON.stringify(audit.event);

    expect(serialised).not.toContain(NAME);
    expect(serialised).not.toContain("Grace Hopper");
    expect(serialised).not.toContain('"12"');
  });

  it("records a stale save as a FAILURE with its reason and no paths", async () => {
    const doc = await aStoredInbox();
    await editInboxPayload(idOf(doc), anEdit());

    await editInboxPayload(
      idOf(doc),
      anEdit({ payload: anEditedEvent({ id: "evt-9" }) }),
    ).catch(() => {});

    const failure = (await auditsFor(doc)).find(
      (audit) => audit.event.audit.status === "FAILURE",
    );

    expect(failure.event.audit.details.event).toEqual({
      box: "inbox",
      actor: "donatas",
      caller: "test-client",
      revision: 0,
      reason: "STALE",
    });
  });

  it("records a refused payload as a FAILURE with its reason", async () => {
    const doc = await aStoredInbox();

    await editInboxPayload(idOf(doc), anEdit({ payload: STORED_EVENT })).catch(
      () => {},
    );

    const [failure] = await auditsFor(doc);

    expect(failure.event.audit.status).toBe("FAILURE");
    expect(failure.event.audit.details.event.reason).toBe("UNCHANGED");
  });
});

// The audit insert joins the edit's transaction, so an audit that cannot be
// written takes the edit down with it.
describe("an edit whose audit event cannot be written", () => {
  const refuseAuditsFor = (doc) =>
    db.command({
      collMod: "outbox",
      validator: { segregationRef: { $ne: `edit-event-${idOf(doc)}` } },
      validationLevel: "strict",
      validationAction: "error",
    });

  afterEach(async () => {
    await db.command({ collMod: "outbox", validator: {} });
  });

  it("fails, and leaves the row as it was", async () => {
    const doc = await aStoredInbox();
    await refuseAuditsFor(doc);

    const refusal = await refusalOf(editInboxPayload(idOf(doc), anEdit()));
    const stored = await inbox.findOne({ _id: doc._id });

    expect(refusal.status).toBe(500);
    expect(stored.event).toEqual(STORED_EVENT);
    expect(stored).not.toHaveProperty("payloadRevision");
    expect(stored).not.toHaveProperty("lastEdit");
    expect(stored).not.toHaveProperty("originalPayload");
    expect(await auditsFor(doc)).toHaveLength(0);
  });

  it("leaves the revision free for the next save once auditing works", async () => {
    const doc = await aStoredInbox();
    await refuseAuditsFor(doc);
    await editInboxPayload(idOf(doc), anEdit()).catch(() => {});
    await db.command({ collMod: "outbox", validator: {} });

    const { payload } = await editInboxPayload(idOf(doc), anEdit());

    expect(payload.payloadRevision).toBe(1);
  });
});

describe("POST /actuators/events/outbox/{id}/payload", () => {
  it("404s for an id that does not exist", async () => {
    await expect(editOutboxPayload(UNKNOWN_ID, anEdit())).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  // Nothing is locked: an envelope field is edited like any other.
  it("edits an envelope field and audits it as an outbox edit", async () => {
    const doc = await aStoredOutbox();

    const { payload } = await editOutboxPayload(
      idOf(doc),
      anEdit({ payload: { ...doc.event, messageGroupId: "group-2" } }),
    );

    const stored = await outbox.findOne({ _id: doc._id });
    const [audit] = await auditsFor(doc);

    expect(payload).toEqual({
      payloadRevision: 1,
      changedPaths: ["/messageGroupId"],
      changedPathsTruncated: false,
    });
    expect(stored.status).toBe("DEAD_LETTER");
    expect(stored.event.messageGroupId).toBe("group-2");
    expect(stored.originalPayload).toEqual(doc.event);
    expect(audit.event.audit.details.event).toMatchObject({
      box: "outbox",
      changedPaths: ["/messageGroupId"],
    });
  });

  // An audit record is editable too; its own edit is audited like any other.
  it("edits an audit row", async () => {
    const doc = await aStoredOutbox({
      target: "arn:aws:sns:eu-west-2:000000000000:cw__sns__audit_topic_arn",
    });

    const { res } = await editOutboxPayload(
      idOf(doc),
      anEdit({ payload: { ...doc.event, data: { name: "redacted" } } }),
    );

    expect(res.statusCode).toBe(200);
    expect((await auditsFor(doc))[0].event.audit.status).toBe("SUCCESS");
  });

  it("409s with the current status when the row is COMPLETED", async () => {
    const doc = await aStoredOutbox({ status: "COMPLETED" });

    const refusal = await refusalOf(editOutboxPayload(idOf(doc), anEdit()));

    expect(refusal.status).toBe(409);
    expect(refusal.body.status).toBe("COMPLETED");
  });

  it("412s a stale save", async () => {
    const doc = await aStoredOutbox();
    await editOutboxPayload(
      idOf(doc),
      anEdit({ payload: { ...doc.event, id: "evt-3" } }),
    );

    const refusal = await refusalOf(
      editOutboxPayload(
        idOf(doc),
        anEdit({ payload: { ...doc.event, id: "evt-4" } }),
      ),
    );

    expect(refusal.status).toBe(412);
  });
});

describe("the detail response of an edited row", () => {
  it("offers revision 0 and plain JSON on a row never edited", async () => {
    const doc = await aStoredInbox();

    const { payload } = await getInboxEvent(idOf(doc));

    expect(payload).toMatchObject({
      payloadRevision: 0,
      lastEdit: null,
      payloadIsPlainJson: true,
    });
    expect(payload.originalPayload ?? null).toBeNull();
  });

  it("answers the revision, the edit record and the original", async () => {
    const doc = await aStoredInbox();
    await editInboxPayload(idOf(doc), anEdit());

    const { payload } = await getInboxEvent(idOf(doc));

    expect(payload.payloadRevision).toBe(1);
    expect(payload.lastEdit).toEqual({
      at: expect.any(String),
      by: "donatas",
      note: NOTE,
    });
    expect(payload.originalPayload).toEqual(STORED_EVENT);
  });

  it("says a payload holding a BSON Date is not plain JSON", async () => {
    const doc = await aStoredOutbox({
      event: { id: "evt-2", data: { at: new Date("2026-06-16T10:00:00Z") } },
    });

    const { payload } = await getOutboxEvent(idOf(doc));

    expect(payload.payloadIsPlainJson).toBe(false);
  });
});

describe("a payload holding BSON numbers", () => {
  it("is served as JSON text, and saved back untouched as it", async () => {
    const doc = await aStoredOutbox({
      event: {
        id: "evt-2",
        data: {
          big: Long.fromString("9007199254740993"),
          amount: Decimal128.fromString("1.10"),
          sheetId: 679,
        },
      },
    });

    const { payload: detail } = await getOutboxEvent(idOf(doc));

    expect(detail.payloadIsPlainJson).toBe(false);
    expect(detail.event.data).toEqual({
      big: "9007199254740993",
      amount: "1.10",
      sheetId: 679,
    });

    const { payload: saved } = await editOutboxPayload(
      idOf(doc),
      anEdit({ payload: detail.event }),
    );

    expect(saved.changedPaths).toEqual(["/data/big", "/data/amount"]);

    const row = await outbox.findOne({ _id: doc._id });

    expect(row.event.data).toEqual(detail.event.data);
    expect(row.originalPayload.data.big).toBeInstanceOf(Long);
    expect(row.originalPayload.data.amount).toBeInstanceOf(Decimal128);

    const [audit] = await auditsFor(doc);
    const { beforeHash, afterHash } = audit.event.audit.details.event;

    expect(beforeHash).toBe(afterHash);

    const { payload: after } = await getOutboxEvent(idOf(doc));

    expect(after.payloadIsPlainJson).toBe(true);
    expect(after.originalPayload.data).toEqual(detail.event.data);
  });

  it("serves a safe Long as a number, which an untouched save leaves UNCHANGED", async () => {
    const doc = await aStoredOutbox({
      event: { id: "evt-2", data: { sheetId: Long.fromNumber(679) } },
    });

    const { payload: detail } = await getOutboxEvent(idOf(doc));

    expect(detail.payloadIsPlainJson).toBe(true);
    expect(detail.event.data).toEqual({ sheetId: 679 });

    const refusal = await refusalOf(
      editOutboxPayload(idOf(doc), anEdit({ payload: detail.event })),
    );

    expect(refusal.status).toBe(422);
    expect(refusal.body.reason).toBe("UNCHANGED");
  });
});

// The poller saves a row with `$set: toDocument()`, and no model names the
// edit's fields - so handling the redriven row leaves them in place.
describe("an edited row the poller then handles", () => {
  it.each([
    ["inbox", () => inbox, aStoredInbox, editInboxPayload, redriveInboxEvent],
    [
      "outbox",
      () => outbox,
      aStoredOutbox,
      editOutboxPayload,
      redriveOutboxEvent,
    ],
  ])(
    "keeps the %s edit record, the original and the revision",
    async (_, collection, aStored, edit, redrive) => {
      const doc = await aStored();
      await edit(
        idOf(doc),
        anEdit({ payload: { ...doc.event, id: "evt-edited" } }),
      );
      const edited = await collection().findOne({ _id: doc._id });

      await redrive(idOf(doc), { by: "donatas" });
      const handled = await handledByThePoller(collection(), doc);

      expect(handled.event.id).toBe("evt-edited");
      expect(handled.lastEdit).toEqual(edited.lastEdit);
      expect(handled.originalPayload).toEqual(doc.event);
      expect(handled.payloadRevision).toBe(2);
    },
  );
});
