import { Decimal128, Long } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  DOLLAR_KEY,
  EDIT_NOTE_MAX,
  NOT_AN_OBJECT,
  PAYLOAD_MAX_BYTES,
  TOO_LARGE,
  UNCHANGED,
  auditedEdit,
  checkEdit,
  editConflict,
  editFailureReason,
  editFence,
  editRefusal,
  editUpdate,
  staleEdit,
} from "./event-edit.js";
import { payloadHash } from "./payload-changes.js";

const AT = new Date("2026-06-16T10:00:00.000Z");

const STORED = { id: "evt-1", data: { amount: "12" } };
const EDITED = { id: "evt-1", data: { amount: 12 } };

const refusalReasonOf = (run) => {
  try {
    run();
  } catch (error) {
    return error.output.payload.reason;
  }

  return null;
};

// Pretty-printed as `{\n  "x": "<filler>"\n}`: 13 bytes around the filler.
const WRAPPING_BYTES = 13;

const aPayloadOfBytes = (bytes) => ({ x: "a".repeat(bytes - WRAPPING_BYTES) });

const anEdit = (overrides = {}) => ({
  event: EDITED,
  by: "ada",
  note: "amount was a string",
  revision: 0,
  original: STORED,
  at: AT,
  ...overrides,
});

describe("edit limits", () => {
  it("caps the note at 500 characters", () => {
    expect(EDIT_NOTE_MAX).toBe(500);
  });

  it("bounds the payload at 256 KiB", () => {
    expect(PAYLOAD_MAX_BYTES).toBe(262_144);
  });
});

describe("checkEdit", () => {
  it("answers where the payload changed and the hashes either side", () => {
    expect(checkEdit(STORED, EDITED)).toEqual({
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
      beforeHash: payloadHash(STORED),
      afterHash: payloadHash(EDITED),
    });
  });

  it("accepts BSON numbers sent back untouched as their JSON text, as a Date is", () => {
    const stored = {
      data: {
        big: Long.fromString("9007199254740993"),
        amount: Decimal128.fromString("1.10"),
      },
    };
    const untouched = { data: { big: "9007199254740993", amount: "1.10" } };

    const result = checkEdit(stored, untouched);

    expect(result.changedPaths).toEqual(["/data/big", "/data/amount"]);
    expect(result.beforeHash).toBe(result.afterHash);
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "{}"],
  ])("refuses %s as NOT_AN_OBJECT", (_, payload) => {
    expect(refusalReasonOf(() => checkEdit(STORED, payload))).toBe(
      NOT_AN_OBJECT,
    );
  });

  it.each([
    ["at the top", { $set: 1 }],
    ["nested", { data: { $where: "x" } }],
    ["inside an array", { data: [{ ok: 1 }, { $in: [] }] }],
  ])("refuses a $ key %s as DOLLAR_KEY", (_, payload) => {
    expect(refusalReasonOf(() => checkEdit(STORED, payload))).toBe(DOLLAR_KEY);
  });

  it("allows a $ that does not start a key", () => {
    expect(() => checkEdit(STORED, { price$: "$5" })).not.toThrow();
  });

  it("refuses a payload one byte over the bound as TOO_LARGE", () => {
    expect(
      refusalReasonOf(() =>
        checkEdit(STORED, aPayloadOfBytes(PAYLOAD_MAX_BYTES + 1)),
      ),
    ).toBe(TOO_LARGE);
  });

  it("accepts a payload exactly at the bound", () => {
    expect(() =>
      checkEdit(STORED, aPayloadOfBytes(PAYLOAD_MAX_BYTES)),
    ).not.toThrow();
  });

  // Compact it fits; as the admin shows it, it does not.
  it("measures the payload pretty-printed", () => {
    const payload = {
      list: Array.from({ length: 40_000 }, (_, i) => i % 10),
    };

    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
      PAYLOAD_MAX_BYTES,
    );
    expect(refusalReasonOf(() => checkEdit(STORED, payload))).toBe(TOO_LARGE);
  });

  it("counts bytes, not characters", () => {
    const characters = Math.floor((PAYLOAD_MAX_BYTES - WRAPPING_BYTES) / 2) + 1;
    const payload = { x: "é".repeat(characters) };

    expect(characters + WRAPPING_BYTES).toBeLessThan(PAYLOAD_MAX_BYTES);

    expect(refusalReasonOf(() => checkEdit(STORED, payload))).toBe(TOO_LARGE);
  });

  it("refuses the stored payload over again as UNCHANGED", () => {
    expect(
      refusalReasonOf(() => checkEdit(STORED, structuredClone(STORED))),
    ).toBe(UNCHANGED);
  });

  it("answers 422 with the reason in the body and no payload in the message", () => {
    let error;

    try {
      checkEdit(STORED, { data: { $bad: "Ada Lovelace" } });
    } catch (e) {
      error = e;
    }

    expect(error.output.statusCode).toBe(422);
    expect(error.output.payload).toMatchObject({
      statusCode: 422,
      reason: DOLLAR_KEY,
    });
    expect(JSON.stringify(error.output.payload)).not.toContain("Ada");
  });
});

describe("editRefusal", () => {
  it.each([TOO_LARGE, UNCHANGED, NOT_AN_OBJECT, DOLLAR_KEY])(
    "gives %s its own message",
    (reason) => {
      const { output } = editRefusal(reason);

      expect(output.statusCode).toBe(422);
      expect(output.payload.reason).toBe(reason);
      expect(output.payload.message).not.toBe("Unprocessable Entity");
    },
  );
});

describe("staleEdit", () => {
  it("is a 412 naming the box and the event", () => {
    const { output } = staleEdit("Inbox", "665f1c2e9a1b2c3d4e5f6a7b");

    expect(output.statusCode).toBe(412);
    expect(output.payload.message).toBe(
      'Inbox event "665f1c2e9a1b2c3d4e5f6a7b" was edited since the given revision',
    );
  });
});

describe("editConflict", () => {
  it("is a 409 in an edit's own words, carrying the status", () => {
    const { message, output } = editConflict("Inbox", "abc", "COMPLETED");

    expect(output.statusCode).toBe(409);
    expect(message).toBe(
      'Inbox event "abc" is COMPLETED, not editable (DEAD_LETTER or PURGED)',
    );
    expect(output.payload.status).toBe("COMPLETED");
  });
});

describe("editFailureReason", () => {
  it.each([
    [404, {}, "NOT_FOUND"],
    [409, { status: "COMPLETED" }, "NOT_EDITABLE"],
    [412, {}, "STALE"],
    [422, { reason: DOLLAR_KEY }, DOLLAR_KEY],
    [422, {}, null],
    [500, {}, null],
  ])("reads a %s %o as %s", (statusCode, payload, reason) => {
    expect(editFailureReason({ output: { statusCode, payload } })).toBe(reason);
  });

  it("is null for an error with no HTTP shape", () => {
    expect(editFailureReason(new Error("boom"))).toBeNull();
  });
});

describe("editFence", () => {
  it("matches a row never edited on a missing counter", () => {
    expect(editFence(0)).toEqual({
      status: { $in: ["DEAD_LETTER", "PURGED"] },
      payloadRevision: null,
    });
  });

  it("matches an edited row on its exact counter", () => {
    expect(editFence(3).payloadRevision).toBe(3);
  });
});

describe("editUpdate", () => {
  it("replaces the payload, bumps the counter and records the edit", () => {
    expect(editUpdate(anEdit({ revision: 2, original: undefined }))).toEqual({
      $set: {
        event: EDITED,
        payloadRevision: 3,
        lastEdit: {
          at: "2026-06-16T10:00:00.000Z",
          by: "ada",
          note: "amount was a string",
        },
      },
    });
  });

  it("keeps the original on the first edit", () => {
    expect(editUpdate(anEdit({ revision: 0 })).$set).toMatchObject({
      payloadRevision: 1,
      originalPayload: STORED,
    });
  });

  it("leaves the first edit's original alone on any later one", () => {
    expect(
      editUpdate(anEdit({ revision: 1, original: undefined })).$set,
    ).not.toHaveProperty("originalPayload");
  });

  // A purge or a redrive moves the revision on without an edit.
  it("keeps an original given past revision 0", () => {
    expect(editUpdate(anEdit({ revision: 1 })).$set).toMatchObject({
      payloadRevision: 2,
      originalPayload: STORED,
    });
  });

  it("sets the inbox columns derived from the new envelope", () => {
    expect(
      editUpdate(
        anEdit({
          inboxColumns: { type: "new.type", eventTime: "2026-06-17T00:00:00Z" },
        }),
      ).$set,
    ).toMatchObject({ type: "new.type", eventTime: "2026-06-17T00:00:00Z" });
  });

  it("never touches the status, so the row stays where it is", () => {
    expect(editUpdate(anEdit()).$set).not.toHaveProperty("status");
  });
});

describe("auditedEdit", () => {
  it("carries the paths and hashes of a save", () => {
    expect(
      auditedEdit({
        payloadRevision: 1,
        changedPaths: ["/a"],
        changedPathsTruncated: false,
        beforeHash: "b",
        afterHash: "a",
      }),
    ).toEqual({
      changedPaths: ["/a"],
      changedPathsTruncated: false,
      beforeHash: "b",
      afterHash: "a",
    });
  });

  it("adds only the reason for a refused save", () => {
    expect(auditedEdit(undefined, staleEdit("Inbox", "abc"))).toEqual({
      reason: "STALE",
    });
  });
});
