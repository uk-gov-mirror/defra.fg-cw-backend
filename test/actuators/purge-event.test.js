import { MongoClient, ObjectId } from "mongodb";
import { env } from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getInboxEvent,
  purgeInboxEvent,
  purgeOutboxEvent,
  redriveInboxEvent,
} from "../helpers/actuators.js";

let client;
let inbox;
let outbox;

const UNKNOWN_ID = "665f1c2e9a1b2c3d4e5f6aaa";
const MAX_RETRIES = 5;
const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;
// The clock moves between request and assertion; a minute of slack is plenty.
const SLACK_MS = 60_000;

const bodyOf = (error) => {
  const payload = error.data?.payload;

  return Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload;
};

const statusOf = (error) => error.output.statusCode;

// The audit event this service wrote about the row, which shares the outbox
// with the events the row itself is one of.
const auditFor = (doc) =>
  outbox.findOne({
    "event.audit.entities.entityid": doc._id.toHexString(),
    "event.audit.entities.action": "PURGE_EVENT",
  });

const aDeadInboxDoc = (overrides = {}) => ({
  _id: new ObjectId(),
  messageId: `msg-${new ObjectId().toHexString()}`,
  type: "cloud.defra.prd.fg-gas-backend.case.create.new",
  source: "GAS",
  // unique, so the poller cannot claim it mid-test
  segregationRef: `PURGE-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  eventTime: "2026-06-16T10:00:00.000Z",
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
  expireAt: null,
  lastPurge: null,
  lastError: {
    name: "TypeError",
    message: "boom",
    at: "2026-06-16T10:05:00.000Z",
  },
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  event: { id: "evt-1", time: "2026-06-16T10:00:00.000Z", data: {} },
  ...overrides,
});

const aDeadOutboxDoc = (overrides = {}) => ({
  _id: new ObjectId(),
  target: "arn:aws:sns:eu-west-2:000000000000:cw__sns__create_case_fifo.fifo",
  segregationRef: `PURGE-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  publicationDate: new Date("2026-06-16T10:00:00.000Z"),
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
  expireAt: null,
  lastPurge: null,
  lastError: null,
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  event: { id: "evt-2", type: "cloud.defra.prd.fg-cw-backend.x", data: {} },
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

// `by` is not optional on a purge: the audit event is written under it.
const aReason = (overrides = {}) => ({
  by: "donatas",
  reasonCode: "BROKEN_PAYLOAD",
  ...overrides,
});

// The running service sweeps every 250 ms, so a row at the cap in PUBLISHED,
// FAILED, RESUBMITTED or PROCESSING is dead-lettered before the assertion
// reads it. The cases that need a row to sit still use only what the sweeps
// leave alone; the full status matrix is a unit test's job.
const HELD_CLAIM = {
  completionAttempts: 0,
  claimedBy: "purge-test",
  claimedAt: new Date("2026-06-16T10:00:00.000Z"),
  claimExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

const UNSWEPT_STATUSES = [
  ["COMPLETED", {}],
  ["PURGED", {}],
  ["PROCESSING", HELD_CLAIM],
];

const isAbout = (date, expected) =>
  Math.abs(date.getTime() - expected) <= SLACK_MS;

const retentionFromNow = () => Date.now() + RETENTION_DAYS * DAY_MS;

beforeAll(async () => {
  client = await MongoClient.connect(env.MONGO_URI);
  inbox = client.db().collection("inbox");
  outbox = client.db().collection("outbox");
});

afterAll(async () => {
  await client?.close(true);
});

describe("POST /actuators/events/inbox/{id}/purge", () => {
  it("rejects a request with no token", async () => {
    await expect(purgeInboxEvent(UNKNOWN_ID, aReason(), null)).rejects.toThrow(
      "Response Error: 401 Unauthorized",
    );
  });

  it("rejects an id that is not a 24-hex ObjectId with 400", async () => {
    await expect(purgeInboxEvent("nope", aReason())).rejects.toThrow(
      "Response Error: 400 Bad Request",
    );
  });

  it("404s for an id that does not exist", async () => {
    await expect(purgeInboxEvent(UNKNOWN_ID, aReason())).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  it("answers 204 with no body and leaves the row PURGED", async () => {
    const doc = await aStoredInbox();

    const { res, payload } = await purgeInboxEvent(
      doc._id.toHexString(),
      aReason(),
    );

    expect(res.statusCode).toBe(204);
    expect(payload).toHaveLength(0);
    expect((await inbox.findOne({ _id: doc._id })).status).toBe("PURGED");
  });

  it("records who purged it, why and when", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "SENT_IN_ERROR",
      note: "duplicate of the January load",
    });

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.lastPurge).toEqual({
      at: expect.any(String),
      by: "donatas",
      reasonCode: "SENT_IN_ERROR",
      note: "duplicate of the January load",
    });
    expect(isAbout(new Date(stored.lastPurge.at), Date.now())).toBe(true);
  });

  it("stores a purge with no note as a null note", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), aReason());

    expect((await inbox.findOne({ _id: doc._id })).lastPurge.note).toBeNull();
  });

  it("gives the row a BSON Date deletion deadline one retention period out", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), aReason());

    const { expireAt } = await inbox.findOne({ _id: doc._id });

    expect(expireAt).toBeInstanceOf(Date);
    expect(isAbout(expireAt, retentionFromNow())).toBe(true);
  });

  it("keeps the payload, the attempt count and the error", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), aReason());

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.event).toEqual(doc.event);
    expect(stored.completionAttempts).toBe(MAX_RETRIES);
    expect(stored.lastError.message).toBe("boom");
  });

  it("writes its own audit event alongside the purged row", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "SENT_IN_ERROR",
    });

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.status).toBe("PURGED");

    const audit = await auditFor(doc);

    expect(audit).not.toBeNull();
    expect(audit.event.audit.entities[0]).toMatchObject({
      entity: "EVENT",
      action: "PURGE_EVENT",
      entityid: doc._id.toHexString(),
    });
    expect(audit.event.audit.status).toBe("SUCCESS");
    expect(audit.event.audit.details.event).toMatchObject({
      box: "inbox",
      actor: "donatas",
      reasonCode: "SENT_IN_ERROR",
    });
  });

  // The row holds the note; the audit event carries the reason code alone.
  it("keeps the operator's note out of the audit event", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "OTHER",
      note: "chased by Ada Lovelace",
    });

    const audit = await auditFor(doc);

    expect(audit.event.audit.details.event).not.toHaveProperty("note");
    expect(JSON.stringify(audit.event.audit)).not.toContain("Ada Lovelace");
  });

  // "System" is the log line's wording for an absent operator, and a purge
  // cannot have one: the audit event names the person it was made for.
  it("never records the purge against System", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), aReason({ by: "ada" }));

    const audit = await auditFor(doc);

    expect(audit.event.audit.details.event.actor).toBe("ada");
    expect(JSON.stringify(audit.event.audit)).not.toContain("System");
  });

  // A refused attempt is still an attempt: the audit event is written outside
  // the aborted transaction, so the refusal is on the record too.
  it("records a refused purge as a FAILURE, leaving the row alone", async () => {
    const doc = await aStoredInbox({ status: "COMPLETED" });

    await purgeInboxEvent(doc._id.toHexString(), aReason()).catch(() => {});

    expect((await inbox.findOne({ _id: doc._id })).status).toBe("COMPLETED");
    expect((await auditFor(doc)).event.audit.status).toBe("FAILURE");
  });
});

describe("the purge fence", () => {
  it.each(UNSWEPT_STATUSES)(
    "409s with the current status when the row is %s",
    async (status, overrides) => {
      const doc = await aStoredInbox({ status, ...overrides });

      const error = await purgeInboxEvent(
        doc._id.toHexString(),
        aReason(),
      ).catch((e) => e);

      expect(statusOf(error)).toBe(409);
      expect(bodyOf(error).status).toBe(status);
      expect(bodyOf(error).message).toContain("not DEAD_LETTER");
    },
  );

  // At the cap, so a sweep matching on the attempt count alone would flip it.
  it("leaves a non-DEAD_LETTER row untouched", async () => {
    const doc = await aStoredInbox({ status: "COMPLETED" });

    await purgeInboxEvent(doc._id.toHexString(), aReason()).catch(() => {});

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.status).toBe("COMPLETED");
    expect(stored.lastPurge).toBeNull();
    expect(stored.expireAt).toBeNull();
  });

  it("409s on a second purge - the update is the precondition", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), aReason());
    const error = await purgeInboxEvent(doc._id.toHexString(), aReason()).catch(
      (e) => e,
    );

    expect(statusOf(error)).toBe(409);
    expect(bodyOf(error).status).toBe("PURGED");
  });
});

describe("purge validation", () => {
  // The operator is valid throughout, so each case fails on the body alone.
  const rejects = async (payload) =>
    expect(
      purgeInboxEvent((await aStoredInbox())._id.toHexString(), {
        by: "donatas",
        ...payload,
      }),
    ).rejects.toThrow("Response Error: 400 Bad Request");

  it("rejects a request with no reason at all", async () => {
    await rejects({});
  });

  it("rejects a reason code outside the fixed set", async () => {
    await rejects({ reasonCode: "DONT_LIKE_IT" });
  });

  it("rejects OTHER with no note - the code that explains nothing", async () => {
    await rejects({ reasonCode: "OTHER" });
  });

  it("rejects OTHER with a blank note", async () => {
    await rejects({ reasonCode: "OTHER", note: "   " });
  });

  it("rejects OTHER with a null note, blank by another name", async () => {
    await rejects({ reasonCode: "OTHER", note: null });
  });

  it("rejects a note of 501 characters", async () => {
    await rejects({ reasonCode: "OTHER", note: "x".repeat(501) });
  });

  it("accepts a note of exactly 500 characters", async () => {
    const doc = await aStoredInbox();

    const { res } = await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "OTHER",
      note: "x".repeat(500),
    });

    expect(res.statusCode).toBe(204);
    expect((await inbox.findOne({ _id: doc._id })).lastPurge.note).toHaveLength(
      500,
    );
  });

  it.each(["BROKEN_PAYLOAD", "SENT_IN_ERROR"])(
    "accepts %s with the note key absent",
    async (reasonCode) => {
      const doc = await aStoredInbox();

      const { res } = await purgeInboxEvent(doc._id.toHexString(), {
        by: "donatas",
        reasonCode,
      });

      expect(res.statusCode).toBe(204);
    },
  );

  // A caller that serialises an empty note box as null means "no note".
  it("reads a null note as an absent one and stores null", async () => {
    const doc = await aStoredInbox();

    const { res } = await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
      note: null,
    });

    expect(res.statusCode).toBe(204);
    expect((await inbox.findOne({ _id: doc._id })).lastPurge.note).toBeNull();
  });

  it("rejects a purge with no operator - nobody would own the audit event", async () => {
    const doc = await aStoredInbox();

    await expect(
      purgeInboxEvent(doc._id.toHexString(), { reasonCode: "BROKEN_PAYLOAD" }),
    ).rejects.toThrow("Response Error: 400 Bad Request");

    expect((await inbox.findOne({ _id: doc._id })).status).toBe("DEAD_LETTER");
  });

  it("rejects a blank operator", async () => {
    const doc = await aStoredInbox();

    await expect(
      purgeInboxEvent(doc._id.toHexString(), {
        by: "   ",
        reasonCode: "BROKEN_PAYLOAD",
      }),
    ).rejects.toThrow("Response Error: 400 Bad Request");
  });

  it("validates before it writes, leaving the row DEAD_LETTER", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "OTHER",
    }).catch(() => {});

    expect((await inbox.findOne({ _id: doc._id })).status).toBe("DEAD_LETTER");
  });
});

describe("redrive and purge together", () => {
  it("redrives a PURGED row, clearing the deletion date and keeping the record", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
      note: "no caseRef",
    });

    const purged = await inbox.findOne({ _id: doc._id });

    expect(purged.status).toBe("PURGED");

    const { res } = await redriveInboxEvent(doc._id.toHexString());
    const redriven = await inbox.findOne({ _id: doc._id });

    expect(res.statusCode).toBe(204);
    expect(redriven.status).toBe("RESUBMITTED");
    expect(redriven.expireAt).toBeNull();
    expect(redriven.lastPurge).toEqual(purged.lastPurge);
  });

  // The state a row reaches after a purge, a redrive and another death.
  it("replaces the whole record on a second purge", async () => {
    const first = {
      at: "2026-06-16T11:00:00.000Z",
      by: "ada",
      reasonCode: "OTHER",
      note: "the first decision",
    };
    const doc = await aStoredInbox({ lastPurge: first });

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "SENT_IN_ERROR",
    });

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.lastPurge).toEqual({
      at: expect.any(String),
      by: "donatas",
      reasonCode: "SENT_IN_ERROR",
      note: null,
    });
    expect(stored.lastPurge.at).not.toBe(first.at);
  });

  it("tells a redrive of a non-redrivable row which statuses are", async () => {
    const doc = await aStoredInbox({ status: "COMPLETED" });

    const error = await redriveInboxEvent(doc._id.toHexString()).catch(
      (e) => e,
    );

    expect(statusOf(error)).toBe(409);
    expect(bodyOf(error).message).toContain(
      "not redrivable (DEAD_LETTER or PURGED)",
    );
  });
});

describe("the detail response", () => {
  it("offers a deletion date on a DEAD_LETTER row and no purge record", async () => {
    const doc = await aStoredInbox();

    const { payload } = await getInboxEvent(doc._id.toHexString());

    expect(
      isAbout(new Date(payload.purgeDeletionDate), retentionFromNow()),
    ).toBe(true);
    expect(payload.lastPurge).toBeNull();
    expect(payload.expireAt).toBeNull();
  });

  // Once purged, the stored `expireAt` is the real date and the projection
  // stands down.
  it("stops offering one once the row is purged, and answers the record", async () => {
    const doc = await aStoredInbox();

    await purgeInboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
      note: "no caseRef",
    });

    const { payload } = await getInboxEvent(doc._id.toHexString());

    expect(payload.status).toBe("PURGED");
    expect(payload.purgeDeletionDate).toBeNull();
    expect(payload.lastPurge).toEqual({
      at: expect.any(String),
      by: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
      note: "no caseRef",
    });
    expect(isAbout(new Date(payload.expireAt), retentionFromNow())).toBe(true);
  });

  it.each(UNSWEPT_STATUSES)(
    "offers no deletion date on a %s row, which cannot be purged",
    async (status, overrides) => {
      const doc = await aStoredInbox({ status, ...overrides });

      const { payload } = await getInboxEvent(doc._id.toHexString());

      expect(payload.purgeDeletionDate).toBeNull();
    },
  );
});

describe("POST /actuators/events/outbox/{id}/purge", () => {
  it("404s for an id that does not exist", async () => {
    await expect(purgeOutboxEvent(UNKNOWN_ID, aReason())).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  it("answers 204 with no body and leaves the row PURGED with a deadline", async () => {
    const doc = await aStoredOutbox();

    const { res, payload } = await purgeOutboxEvent(doc._id.toHexString(), {
      by: "donatas",
      reasonCode: "OTHER",
      note: "published by hand instead",
    });

    const stored = await outbox.findOne({ _id: doc._id });

    expect(res.statusCode).toBe(204);
    expect(payload).toHaveLength(0);
    expect(stored.status).toBe("PURGED");
    expect(stored.lastPurge.reasonCode).toBe("OTHER");
    expect(stored.lastPurge.note).toBe("published by hand instead");
    expect(isAbout(stored.expireAt, retentionFromNow())).toBe(true);
  });

  it("writes its own audit event alongside the purged row", async () => {
    const doc = await aStoredOutbox();

    await purgeOutboxEvent(doc._id.toHexString(), {
      by: "donatas",
      ...aReason(),
    });

    const audit = await auditFor(doc);

    expect(audit.event.audit.entities[0]).toMatchObject({
      entity: "EVENT",
      action: "PURGE_EVENT",
      entityid: doc._id.toHexString(),
    });
    expect(audit.event.audit.details.event).toMatchObject({
      box: "outbox",
      actor: "donatas",
      reasonCode: "BROKEN_PAYLOAD",
    });
  });

  it("409s with the current status when the row is not DEAD_LETTER", async () => {
    const doc = await aStoredOutbox({ status: "COMPLETED" });

    const error = await purgeOutboxEvent(
      doc._id.toHexString(),
      aReason(),
    ).catch((e) => e);

    expect(statusOf(error)).toBe(409);
    expect(bodyOf(error).status).toBe("COMPLETED");
  });

  it("rejects OTHER with no note", async () => {
    const doc = await aStoredOutbox();

    await expect(
      purgeOutboxEvent(doc._id.toHexString(), {
        by: "donatas",
        reasonCode: "OTHER",
      }),
    ).rejects.toThrow("Response Error: 400 Bad Request");
  });
});
