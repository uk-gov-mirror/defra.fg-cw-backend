import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../common/config.js";
import {
  OTHER,
  PURGED,
  PURGE_NOTE_MAX_LENGTH,
  PURGE_REASON_CODES,
  purgeConflict,
  purgeUpdate,
} from "./event-purge.js";
import {
  DEAD_LETTER,
  REDRIVABLE_STATUSES,
  redriveConflict,
} from "./event-redrive.js";

const ID = "665f1c2e9a1b2c3d4e5f6a7b";
const NOW = new Date("2026-06-16T10:00:00.000Z");
const RETENTION_DAYS = config.get("events.retentionDays");
const DAY_MS = 86_400_000;

const aPurge = (overrides = {}) => ({
  by: "ada",
  reasonCode: "BROKEN_PAYLOAD",
  note: "the payload has no caseRef",
  ...overrides,
});

describe("purge reason codes", () => {
  it("is the fixed set the admin offers, with OTHER last", () => {
    expect(PURGE_REASON_CODES).toEqual([
      "BROKEN_PAYLOAD",
      "SENT_IN_ERROR",
      OTHER,
    ]);
  });

  it("caps a note at 500 characters, so nobody pastes a payload into it", () => {
    expect(PURGE_NOTE_MAX_LENGTH).toBe(500);
  });

  it("purges from DEAD_LETTER and redrives back out of PURGED", () => {
    expect(DEAD_LETTER).toBe("DEAD_LETTER");
    expect(REDRIVABLE_STATUSES).toContain(PURGED);
  });
});

describe("purgeUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the row PURGED", () => {
    expect(purgeUpdate(aPurge()).$set.status).toBe(PURGED);
  });

  it("records who purged it, why, and when", () => {
    expect(purgeUpdate(aPurge()).$set.lastPurge).toEqual({
      at: NOW.toISOString(),
      by: "ada",
      reasonCode: "BROKEN_PAYLOAD",
      note: "the payload has no caseRef",
    });
  });

  it("stores the purge time as an ISO string", () => {
    expect(typeof purgeUpdate(aPurge()).$set.lastPurge.at).toBe("string");
  });

  it("stores an absent note as null, so every purged row has one shape", () => {
    expect(purgeUpdate(aPurge({ note: undefined })).$set.lastPurge.note).toBe(
      null,
    );
  });

  it("stores an unattributed purge as a null operator", () => {
    expect(purgeUpdate(aPurge({ by: undefined })).$set.lastPurge.by).toBeNull();
    expect(JSON.stringify(purgeUpdate(aPurge({ by: null })))).not.toContain(
      "System",
    );
  });

  it("gives the row a deletion date one retention period out", () => {
    expect(purgeUpdate(aPurge()).$set.expireAt).toEqual(
      new Date(NOW.getTime() + RETENTION_DAYS * DAY_MS),
    );
  });

  // A TTL index silently ignores anything else, so a string is never deleted.
  it("writes the deletion date as a BSON Date, not a string", () => {
    expect(purgeUpdate(aPurge()).$set.expireAt).toBeInstanceOf(Date);
  });

  it("dates the record and the deadline from the same instant", () => {
    const { lastPurge, expireAt } = purgeUpdate(aPurge()).$set;

    expect(expireAt.getTime() - Date.parse(lastPurge.at)).toBe(
      RETENTION_DAYS * DAY_MS,
    );
  });

  it("replaces the whole record rather than merging into it", () => {
    const update = purgeUpdate(aPurge({ note: undefined, by: undefined }));

    expect(Object.keys(update)).toEqual(["$set"]);
    expect(Object.keys(update.$set.lastPurge).sort()).toEqual([
      "at",
      "by",
      "note",
      "reasonCode",
    ]);
  });

  // Purging is not redaction: the payload is what makes a redrive possible.
  it("touches nothing but the status, the record and the deadline", () => {
    expect(Object.keys(purgeUpdate(aPurge()).$set).sort()).toEqual([
      "expireAt",
      "lastPurge",
      "status",
    ]);
  });

  it("can be given the instant, so a caller can date it deterministically", () => {
    const at = new Date("2020-01-01T00:00:00.000Z");

    expect(purgeUpdate(aPurge({ at })).$set.lastPurge.at).toBe(
      at.toISOString(),
    );
  });
});

describe("purgeConflict", () => {
  it("is a 409", () => {
    expect(purgeConflict("Inbox", ID, "COMPLETED").output.statusCode).toBe(409);
  });

  it("puts the current status in the body", () => {
    expect(purgeConflict("Inbox", ID, "COMPLETED").output.payload.status).toBe(
      "COMPLETED",
    );
  });

  it("names the box, the id and the status a purge needs", () => {
    expect(
      purgeConflict("Outbox", ID, "PUBLISHED").output.payload.message,
    ).toBe(`Outbox event "${ID}" is PUBLISHED, not DEAD_LETTER`);
  });

  it("has the same body shape as a redrive conflict", () => {
    const purged = purgeConflict("Inbox", ID, "COMPLETED").output.payload;
    const redriven = redriveConflict("Inbox", ID, "COMPLETED").output.payload;

    expect(Object.keys(purged).sort()).toEqual(Object.keys(redriven).sort());
    expect(purged.statusCode).toBe(redriven.statusCode);
    expect(purged.error).toBe(redriven.error);
  });
});
