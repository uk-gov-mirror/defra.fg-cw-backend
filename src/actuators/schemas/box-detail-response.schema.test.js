import { describe, expect, it } from "vitest";
import {
  inboxDetailResponseSchema,
  outboxDetailResponseSchema,
} from "./box-detail-response.schema.js";

const aDetail = (overrides = {}) => ({
  _id: "665f1c2e9a1b2c3d4e5f6a7b",
  type: "cloud.defra.prd.fg-gas-backend.case.create.new",
  status: "DEAD_LETTER",
  completionAttempts: 5,
  maxAttempts: 5,
  segregationRef: "GLD-9B2",
  event: { id: "evt-1", data: { clientRef: "REF-1" } },
  lastError: { name: "TypeError", message: "boom", at: null },
  lastResubmissionDate: null,
  completionDate: null,
  publicationDate: "2026-06-16T10:00:00.000Z",
  attemptHistory: [],
  payloadRevision: 0,
  payloadIsPlainJson: true,
  ...overrides,
});

const anInbox = (overrides = {}) =>
  aDetail({
    messageId: "msg-1",
    source: "GAS",
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    eventTime: "2026-06-16T10:00:00.000Z",
    ...overrides,
  });

const anOutbox = (overrides = {}) =>
  aDetail({
    target: "arn:aws:sns:eu-west-2:000000000000:cw__sns__create_case.fifo",
    ...overrides,
  });

describe("inboxDetailResponseSchema", () => {
  it("is labelled InboxEventDetail", () => {
    expect(inboxDetailResponseSchema.describe().flags.label).toBe(
      "InboxEventDetail",
    );
  });

  it("accepts a whole inbox document", () => {
    expect(inboxDetailResponseSchema.validate(anInbox()).error).toBeUndefined();
  });

  it("accepts an arbitrary event payload", () => {
    const event = { anything: { at: "all" }, list: [1, 2, 3] };

    expect(
      inboxDetailResponseSchema.validate(anInbox({ event })).error,
    ).toBeUndefined();
  });

  it("requires the event payload key", () => {
    const { event, ...withoutEvent } = anInbox();

    expect(
      inboxDetailResponseSchema.validate(withoutEvent).error,
    ).toBeDefined();
  });

  it.each([
    ["claimedBy", "claim-token"],
    ["claimedAt", "2026-06-16T10:00:00.000Z"],
    ["claimExpiresAt", "2026-06-16T10:00:05.000Z"],
  ])("rejects a %s", (field, value) => {
    const { error } = inboxDetailResponseSchema.validate(
      anInbox({ [field]: value }),
    );

    expect(error.message).toContain(field);
  });

  it("tolerates unknown fields from another service version", () => {
    expect(
      inboxDetailResponseSchema.validate(anInbox({ somethingNew: 1 })).error,
    ).toBeUndefined();
  });

  it("requires maxAttempts", () => {
    const { maxAttempts, ...without } = anInbox();

    expect(inboxDetailResponseSchema.validate(without).error).toBeDefined();
  });
});

describe("outboxDetailResponseSchema", () => {
  it("is labelled OutboxEventDetail", () => {
    expect(outboxDetailResponseSchema.describe().flags.label).toBe(
      "OutboxEventDetail",
    );
  });

  it("accepts a whole outbox document", () => {
    expect(
      outboxDetailResponseSchema.validate(anOutbox()).error,
    ).toBeUndefined();
  });

  it("accepts the full target ARN", () => {
    const { value } = outboxDetailResponseSchema.validate(anOutbox());

    expect(value.target).toBe(
      "arn:aws:sns:eu-west-2:000000000000:cw__sns__create_case.fifo",
    );
  });

  it.each(["claimedBy", "claimedAt", "claimExpiresAt"])(
    "rejects a %s",
    (field) => {
      expect(
        outboxDetailResponseSchema.validate(anOutbox({ [field]: "x" })).error,
      ).toBeDefined();
    },
  );
});

describe("detail attemptHistory", () => {
  const anEntry = {
    at: "2026-06-16T10:00:00.000Z",
    name: "ClaimExpired",
    message: "claim expired before completion",
    stack: null,
  };

  it("accepts an empty history on both boxes", () => {
    expect(
      inboxDetailResponseSchema.validate(anInbox({ attemptHistory: [] })).error,
    ).toBeUndefined();
    expect(
      outboxDetailResponseSchema.validate(anOutbox({ attemptHistory: [] }))
        .error,
    ).toBeUndefined();
  });

  it("accepts a history of entries", () => {
    expect(
      inboxDetailResponseSchema.validate(
        anInbox({ attemptHistory: [anEntry, { ...anEntry, at: null }] }),
      ).error,
    ).toBeUndefined();
  });

  it("requires the key, so a mapping gap fails a test rather than a render", () => {
    const { attemptHistory, ...without } = anInbox();

    expect(inboxDetailResponseSchema.validate(without).error).toBeDefined();
  });

  it("rejects null, an entry missing a name and a non-array", () => {
    expect(
      inboxDetailResponseSchema.validate(anInbox({ attemptHistory: null }))
        .error,
    ).toBeDefined();
    expect(
      inboxDetailResponseSchema.validate(
        anInbox({ attemptHistory: [{ at: null, message: "x" }] }),
      ).error,
    ).toBeDefined();
    expect(
      inboxDetailResponseSchema.validate(anInbox({ attemptHistory: {} })).error,
    ).toBeDefined();
  });

  it("allows an empty message, as lastError does", () => {
    expect(
      inboxDetailResponseSchema.validate(
        anInbox({ attemptHistory: [{ ...anEntry, message: "" }] }),
      ).error,
    ).toBeUndefined();
  });
});

describe("detail expireAt", () => {
  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])("accepts an ISO deletion date on a %s detail", (_box, schema, detail) => {
    const value = detail({ expireAt: "2026-09-14T10:00:00.000Z" });

    expect(schema.validate(value).error).toBeUndefined();
  });

  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])(
    "accepts a null deletion date on a %s detail - the row is not terminal",
    (_box, schema, detail) => {
      expect(schema.validate(detail({ expireAt: null })).error).toBeUndefined();
    },
  );

  it("rejects a deletion date that is not a date", () => {
    const value = anInbox({ expireAt: "never" });

    expect(inboxDetailResponseSchema.validate(value).error).toBeDefined();
  });

  it("names PURGED among the statuses a row can hold", () => {
    const { status } = inboxDetailResponseSchema.describe().keys;

    expect(status.flags.description).toContain("PURGED");
  });
});

describe("detail lastPurge", () => {
  const aPurge = (overrides = {}) => ({
    at: "2026-06-16T11:00:00.000Z",
    by: "ada",
    reasonCode: "BROKEN_PAYLOAD",
    note: "no caseRef",
    ...overrides,
  });

  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])("accepts a purge record on a %s detail", (_box, schema, detail) => {
    expect(
      schema.validate(detail({ lastPurge: aPurge() })).error,
    ).toBeUndefined();
  });

  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])(
    "accepts a null purge record on a %s detail - the row was never purged",
    (_box, schema, detail) => {
      expect(
        schema.validate(detail({ lastPurge: null })).error,
      ).toBeUndefined();
    },
  );

  it("accepts a record with no note and no operator", () => {
    const value = anInbox({ lastPurge: aPurge({ by: null, note: null }) });

    expect(inboxDetailResponseSchema.validate(value).error).toBeUndefined();
  });

  it("rejects a purge time that is not a date", () => {
    const value = anInbox({ lastPurge: aPurge({ at: "whenever" }) });

    expect(inboxDetailResponseSchema.validate(value).error).toBeDefined();
  });

  it("is named in the contract rather than let through by .unknown()", () => {
    expect(inboxDetailResponseSchema.describe().keys).toHaveProperty(
      "lastPurge",
    );
    expect(outboxDetailResponseSchema.describe().keys).toHaveProperty(
      "lastPurge",
    );
  });
});

describe("detail purgeDeletionDate", () => {
  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])(
    "accepts a projected deletion date on a %s detail",
    (_box, schema, detail) => {
      const value = detail({ purgeDeletionDate: "2026-12-14T10:00:00.000Z" });

      expect(schema.validate(value).error).toBeUndefined();
    },
  );

  it.each([
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ])(
    "accepts a null projected deletion date on a %s detail",
    (_box, schema, detail) => {
      expect(
        schema.validate(detail({ purgeDeletionDate: null })).error,
      ).toBeUndefined();
    },
  );

  it("rejects one that is not a date", () => {
    const value = anInbox({ purgeDeletionDate: "soon" });

    expect(inboxDetailResponseSchema.validate(value).error).toBeDefined();
  });

  it("is named in the contract rather than let through by .unknown()", () => {
    expect(inboxDetailResponseSchema.describe().keys).toHaveProperty(
      "purgeDeletionDate",
    );
    expect(outboxDetailResponseSchema.describe().keys).toHaveProperty(
      "purgeDeletionDate",
    );
  });
});

describe("detail payload edit fields", () => {
  const schemas = [
    ["inbox", inboxDetailResponseSchema, anInbox],
    ["outbox", outboxDetailResponseSchema, anOutbox],
  ];

  const anEdit = {
    at: "2026-06-16T11:00:00.000Z",
    by: "ada",
    note: "amount was a string",
  };

  it.each(schemas)("names every edit field in the %s schema", (_, schema) => {
    const keys = Object.keys(schema.describe().keys);

    expect(keys).toEqual(
      expect.arrayContaining([
        "payloadRevision",
        "lastEdit",
        "originalPayload",
        "payloadIsPlainJson",
      ]),
    );
  });

  it.each(schemas)("accepts a %s row never edited", (_, schema, aRow) => {
    expect(
      schema.validate(aRow({ lastEdit: null, originalPayload: null })).error,
    ).toBeUndefined();
  });

  it.each(schemas)("accepts an edited %s row", (_, schema, aRow) => {
    const { error } = schema.validate(
      aRow({
        payloadRevision: 2,
        lastEdit: anEdit,
        originalPayload: { id: "evt-1" },
        payloadIsPlainJson: false,
      }),
    );

    expect(error).toBeUndefined();
  });

  it.each(["payloadRevision", "payloadIsPlainJson"])("requires %s", (field) => {
    const { [field]: _, ...without } = anInbox();

    expect(inboxDetailResponseSchema.validate(without).error).toBeDefined();
  });

  it.each([
    ["a negative revision", { payloadRevision: -1 }],
    ["a fractional revision", { payloadRevision: 1.5 }],
    ["a non-boolean plain JSON flag", { payloadIsPlainJson: "yes" }],
    ["an edit time that is not a date", { lastEdit: { ...anEdit, at: "x" } }],
    ["an original payload that is not an object", { originalPayload: [] }],
  ])("rejects %s", (_, overrides) => {
    expect(
      inboxDetailResponseSchema.validate(anInbox(overrides)).error,
    ).toBeDefined();
  });
});
