import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../common/config.js";
import { toDetailDocument } from "./event-detail.js";

const AUDIT_TOPIC_ARN = config.get("aws.sns.auditTopicArn");

const objectId = new ObjectId("665f1c2e9a1b2c3d4e5f6a7b");

const aDoc = (overrides = {}) => ({
  _id: objectId,
  messageId: "msg-1",
  status: "DEAD_LETTER",
  completionAttempts: 5,
  eventTime: "2026-06-16T10:00:00.000Z",
  publicationDate: new Date("2026-06-16T10:00:01.000Z"),
  completionDate: null,
  event: {
    id: "evt-1",
    type: "cloud.defra.prd.fg-gas-backend.case.create.new",
    data: { clientRef: "REF-1", nested: { deep: true } },
  },
  ...overrides,
});

describe("toDetailDocument", () => {
  it("returns the full event payload verbatim", () => {
    const doc = aDoc();

    expect(toDetailDocument(doc, 5).event).toEqual(doc.event);
  });

  it("returns the payload's nested data untouched", () => {
    expect(toDetailDocument(aDoc(), 5).event.data).toEqual({
      clientRef: "REF-1",
      nested: { deep: true },
    });
  });

  it("renders _id as a hex string", () => {
    expect(toDetailDocument(aDoc(), 5)._id).toBe("665f1c2e9a1b2c3d4e5f6a7b");
  });

  it("converts top-level Date values to ISO strings", () => {
    expect(toDetailDocument(aDoc(), 5).publicationDate).toBe(
      "2026-06-16T10:00:01.000Z",
    );
  });

  it("leaves top-level ISO strings alone", () => {
    expect(toDetailDocument(aDoc(), 5).eventTime).toBe(
      "2026-06-16T10:00:00.000Z",
    );
  });

  it("leaves nulls as null", () => {
    expect(toDetailDocument(aDoc(), 5).completionDate).toBeNull();
  });

  it("stamps maxAttempts", () => {
    expect(toDetailDocument(aDoc(), 5).maxAttempts).toBe(5);
  });

  it("does not mutate the document it was given", () => {
    const doc = aDoc({ claimedBy: "claim-token" });

    toDetailDocument(doc, 5);

    expect(doc.claimedBy).toBe("claim-token");
    expect(doc._id).toBe(objectId);
  });

  it("carries unknown fields through", () => {
    expect(toDetailDocument(aDoc({ somethingNew: 1 }), 5).somethingNew).toBe(1);
  });
});

describe("toDetailDocument attemptHistory", () => {
  const anEntry = (message) => ({
    at: "2026-06-16T10:00:00.000Z",
    name: "TypeError",
    message,
    stack: null,
  });

  it("is an empty array on a row written before attempt history existed", () => {
    expect(toDetailDocument(aDoc(), 5).attemptHistory).toEqual([]);
  });

  it("returns the stored history oldest first", () => {
    const attemptHistory = [anEntry("one"), anEntry("two")];

    expect(
      toDetailDocument(aDoc({ attemptHistory }), 5).attemptHistory,
    ).toEqual(attemptHistory);
  });

  it("rebuilds each entry from the four contract keys only", () => {
    const attemptHistory = [
      {
        ...anEntry("one"),
        stack: "Error: boom\n    at handler (x.js:1:1)",
        claimedBy: "SECRET-CLAIM-TOKEN",
      },
    ];

    const [entry] = toDetailDocument(
      aDoc({ attemptHistory }),
      5,
    ).attemptHistory;

    expect(Object.keys(entry)).toEqual(["at", "name", "message", "stack"]);
    expect(entry.stack).toBe("Error: boom\n    at handler (x.js:1:1)");
    expect(entry).not.toHaveProperty("claimedBy");
  });

  it("serves a null stack where the stored entry has none", () => {
    const attemptHistory = [{ at: null, name: "ClaimExpired", message: "x" }];

    const [entry] = toDetailDocument(
      aDoc({ attemptHistory }),
      5,
    ).attemptHistory;

    expect(entry.stack).toBeNull();
  });

  it("tolerates a malformed stored history", () => {
    expect(
      toDetailDocument(aDoc({ attemptHistory: "nope" }), 5).attemptHistory,
    ).toEqual([]);
    expect(
      toDetailDocument(aDoc({ attemptHistory: [{}] }), 5).attemptHistory,
    ).toEqual([{ at: null, name: "Error", message: "", stack: null }]);
  });

  it("serialises a Date `at` and caps a history past ten entries", () => {
    const attemptHistory = Array.from({ length: 14 }, (_, i) => ({
      at: new Date("2026-06-16T10:00:00.000Z"),
      name: "Error",
      message: `${i}`,
    }));

    const history = toDetailDocument(
      aDoc({ attemptHistory }),
      5,
    ).attemptHistory;

    expect(history).toHaveLength(10);
    expect(history.at(0)).toEqual({
      at: "2026-06-16T10:00:00.000Z",
      name: "Error",
      message: "4",
      stack: null,
    });
  });
});

describe("toDetailDocument type labels", () => {
  const anOutboxDoc = (overrides = {}) => ({
    _id: objectId,
    target: "arn:aws:sns:eu-west-2:000000000000:cw__sns__case_status_updated",
    event: { id: "evt-1", type: "cloud.defra.prd.fg-cw-backend.case.create" },
    ...overrides,
  });

  const anInboxDoc = (overrides = {}) => ({
    _id: objectId,
    messageId: "msg-1",
    type: "cloud.defra.prd.fg-gas-backend.case.create.new",
    ...overrides,
  });

  it("states an outbox row's stored type, which lives inside the event", () => {
    const detail = toDetailDocument(anOutboxDoc(), 5, "outbox");

    expect(detail.type).toBe("cloud.defra.prd.fg-cw-backend.case.create");
  });

  it("labels an outbox row addressed at the audit topic", () => {
    const detail = toDetailDocument(
      anOutboxDoc({ target: AUDIT_TOPIC_ARN, event: { audit: {} } }),
      5,
      "outbox",
    );

    expect(detail.type).toBe("audit");
  });

  it("still returns the audit payload on that page", () => {
    const detail = toDetailDocument(
      anOutboxDoc({
        target: AUDIT_TOPIC_ARN,
        event: { audit: { entities: [{ entity: "CASE" }] } },
      }),
      5,
      "outbox",
    );

    expect(detail.event.audit.entities[0].entity).toBe("CASE");
  });

  it("labels a type-less outbox row on another topic unknown", () => {
    const detail = toDetailDocument(
      anOutboxDoc({ event: { id: "evt-1" } }),
      5,
      "outbox",
    );

    expect(detail.type).toBe("unknown");
  });

  it("states an inbox row's stored top-level type", () => {
    const detail = toDetailDocument(anInboxDoc(), 5, "inbox");

    expect(detail.type).toBe("cloud.defra.prd.fg-gas-backend.case.create.new");
  });

  it("never labels an inbox row audit", () => {
    const detail = toDetailDocument(
      anInboxDoc({ type: null, source: AUDIT_TOPIC_ARN }),
      5,
      "inbox",
    );

    expect(detail.type).toBe("unknown");
  });
});

describe("toDetailDocument lastPurge", () => {
  const aPurge = (overrides = {}) => ({
    at: "2026-06-16T11:00:00.000Z",
    by: "ada",
    reasonCode: "BROKEN_PAYLOAD",
    note: "no caseRef",
    ...overrides,
  });

  it("carries the purge record through", () => {
    expect(
      toDetailDocument(aDoc({ lastPurge: aPurge() }), 5).lastPurge,
    ).toEqual(aPurge());
  });

  // Explicitly null rather than missing: an absent key is a worse answer.
  it("answers null for a row that was never purged", () => {
    expect(toDetailDocument(aDoc(), 5).lastPurge).toBeNull();
  });

  it("fills in the parts an older or partial record is missing", () => {
    const detail = toDetailDocument(
      aDoc({ lastPurge: { reasonCode: "SENT_IN_ERROR" } }),
      5,
    );

    expect(detail.lastPurge).toEqual({
      at: null,
      by: null,
      reasonCode: "SENT_IN_ERROR",
      note: null,
    });
  });

  // Only top-level Dates are serialised; a nested one would reach the wire raw.
  it("serialises a stored Date purge time", () => {
    const detail = toDetailDocument(
      aDoc({ lastPurge: aPurge({ at: new Date("2026-06-16T11:00:00.000Z") }) }),
      5,
    );

    expect(detail.lastPurge.at).toBe("2026-06-16T11:00:00.000Z");
  });

  it("is still answered for a row that was redriven out of PURGED", () => {
    const detail = toDetailDocument(
      aDoc({ status: "RESUBMITTED", lastPurge: aPurge() }),
      5,
    );

    expect(detail.status).toBe("RESUBMITTED");
    expect(detail.lastPurge).toEqual(aPurge());
  });
});

describe("toDetailDocument purgeDeletionDate", () => {
  const RETENTION_DAYS = config.get("events.retentionDays");
  const DAY_MS = 86_400_000;
  const NOW = new Date("2026-06-16T10:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers one retention period from now on a DEAD_LETTER row", () => {
    expect(
      toDetailDocument(aDoc({ status: "DEAD_LETTER" }), 5).purgeDeletionDate,
    ).toBe(new Date(NOW.getTime() + RETENTION_DAYS * DAY_MS).toISOString());
  });

  it.each([
    "PUBLISHED",
    "PROCESSING",
    "FAILED",
    "RESUBMITTED",
    "COMPLETED",
    "PURGED",
  ])("answers null on a %s row, which cannot be purged", (status) => {
    expect(toDetailDocument(aDoc({ status }), 5).purgeDeletionDate).toBeNull();
  });

  it("is a projection, never read off the row's own expireAt", () => {
    const detail = toDetailDocument(
      aDoc({ status: "DEAD_LETTER", expireAt: null }),
      5,
    );

    expect(detail.expireAt).toBeNull();
    expect(detail.purgeDeletionDate).not.toBeNull();
  });
});
