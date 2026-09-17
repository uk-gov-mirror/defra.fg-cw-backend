import { MongoClient, ObjectId } from "mongodb";
import { env } from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anAttemptHistory } from "../fixtures/attempt-history.js";
import { redriveInboxEvent, redriveOutboxEvent } from "../helpers/actuators.js";

let client;
let inbox;
let outbox;

const UNKNOWN_ID = "665f1c2e9a1b2c3d4e5f6aaa";
const MAX_RETRIES = 5;

const bodyOf = (error) => {
  const payload = error.data?.payload;

  return Buffer.isBuffer(payload) ? JSON.parse(payload.toString()) : payload;
};

const aHistory = () =>
  anAttemptHistory({ length: MAX_RETRIES, message: "boom" });

const aDeadInboxDoc = (overrides = {}) => ({
  _id: new ObjectId(),
  messageId: `msg-${new ObjectId().toHexString()}`,
  type: "cloud.defra.prd.fg-gas-backend.case.create.new",
  source: "GAS",
  // unique, so the poller cannot claim it mid-test
  segregationRef: `REDRIVE-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  eventTime: "2026-06-16T10:00:00.000Z",
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
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
  segregationRef: `REDRIVE-${new ObjectId().toHexString()}`,
  status: "DEAD_LETTER",
  completionAttempts: MAX_RETRIES,
  publicationDate: new Date("2026-06-16T10:00:00.000Z"),
  lastResubmissionDate: "2026-06-16T10:05:00.000Z",
  completionDate: null,
  lastError: null,
  claimedBy: null,
  claimedAt: null,
  claimExpiresAt: null,
  event: { id: "evt-2", type: "cloud.defra.prd.fg-cw-backend.x", data: {} },
  ...overrides,
});

beforeAll(async () => {
  client = await MongoClient.connect(env.MONGO_URI);
  inbox = client.db().collection("inbox");
  outbox = client.db().collection("outbox");
});

afterAll(async () => {
  await client?.close(true);
});

describe("POST /actuators/events/inbox/{id}/redrive", () => {
  it("rejects a request with no token", async () => {
    await expect(redriveInboxEvent(UNKNOWN_ID, {}, null)).rejects.toThrow(
      "Response Error: 401 Unauthorized",
    );
  });

  it("rejects an id that is not a 24-hex ObjectId with 400", async () => {
    await expect(redriveInboxEvent("nope")).rejects.toThrow(
      "Response Error: 400 Bad Request",
    );
  });

  it("404s for an id that does not exist", async () => {
    await expect(redriveInboxEvent(UNKNOWN_ID)).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  it("answers 204 with no body and leaves the row RESUBMITTED", async () => {
    const doc = aDeadInboxDoc();
    await inbox.insertOne(doc);

    const { res, payload } = await redriveInboxEvent(doc._id.toHexString());

    expect(res.statusCode).toBe(204);
    expect(payload).toHaveLength(0);
    expect((await inbox.findOne({ _id: doc._id })).status).toBe("RESUBMITTED");
  });

  it("writes its own audit event alongside the redriven row", async () => {
    const doc = aDeadInboxDoc();
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString(), { by: "donatas" });

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.status).toBe("RESUBMITTED");

    const audit = await outbox.findOne({
      "event.audit.entities.entityid": doc._id.toHexString(),
      "event.audit.entities.action": "REDRIVE_EVENT",
    });

    expect(audit).not.toBeNull();
    expect(audit.event.audit.entities[0]).toMatchObject({
      entity: "EVENT",
      action: "REDRIVE_EVENT",
      entityid: doc._id.toHexString(),
    });
    expect(audit.event.audit.status).toBe("SUCCESS");
    expect(audit.event.audit.details.event).toMatchObject({
      box: "inbox",
      actor: "donatas",
    });
  });

  // `stripNulls` drops a null actor, so none is stored or invented.
  it("records an unattributed redrive with no actor at all", async () => {
    const doc = aDeadInboxDoc();
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString());

    const audit = await outbox.findOne({
      "event.audit.entities.entityid": doc._id.toHexString(),
      "event.audit.entities.action": "REDRIVE_EVENT",
    });

    expect(audit.event.audit.details.event).not.toHaveProperty("actor");
    expect(JSON.stringify(audit.event.audit)).not.toContain("System");
  });

  it("resets the attempt counter and releases the claim in the database", async () => {
    const doc = aDeadInboxDoc({ claimedBy: "stale", claimedAt: new Date() });
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString());

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.completionAttempts).toBe(0);
    expect(stored.claimedBy).toBeNull();
    expect(stored.claimedAt).toBeNull();
    expect(stored.claimExpiresAt).toBeNull();
  });

  it("clears the attempt history with the counter in the database", async () => {
    const doc = aDeadInboxDoc({ attemptHistory: aHistory() });
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString());

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.completionAttempts).toBe(0);
    expect(stored.attemptHistory).toEqual([]);
    expect(stored.lastError.message).toBe("boom");
  });

  it("keeps lastError and lastResubmissionDate", async () => {
    const doc = aDeadInboxDoc();
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString());

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.lastError.name).toBe("TypeError");
    expect(stored.lastResubmissionDate).toBe("2026-06-16T10:05:00.000Z");
  });

  it("409s with the current status when the row is not DEAD_LETTER", async () => {
    const doc = aDeadInboxDoc({
      status: "COMPLETED",
      completionAttempts: MAX_RETRIES,
    });
    await inbox.insertOne(doc);

    const error = await redriveInboxEvent(doc._id.toHexString()).catch(
      (e) => e,
    );

    expect(error.output.statusCode).toBe(409);
    expect(bodyOf(error).status).toBe("COMPLETED");
  });

  // At the cap, so a dead-letter sweep tick would flip it were the sweep to
  // match on the attempt count alone.
  it("leaves a non-DEAD_LETTER row untouched", async () => {
    const doc = aDeadInboxDoc({
      status: "COMPLETED",
      completionAttempts: MAX_RETRIES,
    });
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString()).catch(() => {});

    const stored = await inbox.findOne({ _id: doc._id });

    expect(stored.status).toBe("COMPLETED");
    expect(stored.completionAttempts).toBe(MAX_RETRIES);
  });

  it("409s on a second redrive - the update is the precondition", async () => {
    const doc = aDeadInboxDoc();
    await inbox.insertOne(doc);

    await redriveInboxEvent(doc._id.toHexString());
    const error = await redriveInboxEvent(doc._id.toHexString()).catch(
      (e) => e,
    );

    expect(error.output.statusCode).toBe(409);
  });
});

describe("POST /actuators/events/outbox/{id}/redrive", () => {
  it("404s for an id that does not exist", async () => {
    await expect(redriveOutboxEvent(UNKNOWN_ID)).rejects.toThrow(
      "Response Error: 404 Not Found",
    );
  });

  it("answers 204 with no body and resets the attempt counter", async () => {
    const doc = aDeadOutboxDoc();
    await outbox.insertOne(doc);

    const { res, payload } = await redriveOutboxEvent(doc._id.toHexString());
    const stored = await outbox.findOne({ _id: doc._id });

    expect(res.statusCode).toBe(204);
    expect(payload).toHaveLength(0);
    expect(stored.status).toBe("RESUBMITTED");
    expect(stored.completionAttempts).toBe(0);
  });

  it("clears the attempt history with the counter in the database", async () => {
    const doc = aDeadOutboxDoc({ attemptHistory: aHistory() });
    await outbox.insertOne(doc);

    await redriveOutboxEvent(doc._id.toHexString());

    const stored = await outbox.findOne({ _id: doc._id });

    expect(stored.completionAttempts).toBe(0);
    expect(stored.attemptHistory).toEqual([]);
  });

  it("409s with the current status when the row is not DEAD_LETTER", async () => {
    const doc = aDeadOutboxDoc({ status: "PUBLISHED" });
    await outbox.insertOne(doc);

    const error = await redriveOutboxEvent(doc._id.toHexString()).catch(
      (e) => e,
    );

    expect(error.output.statusCode).toBe(409);
    expect(bodyOf(error).status).toBe("PUBLISHED");
  });
});
