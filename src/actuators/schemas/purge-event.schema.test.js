import { describe, expect, it } from "vitest";
import { PURGE_NOTE_MAX_LENGTH } from "../../events/event-purge.js";
import { purgeEventPayload } from "./purge-event.schema.js";

const validate = (payload) => purgeEventPayload.validate(payload);
const errorOf = (payload) => validate(payload).error;
const valueOf = (payload) => validate(payload).value;

const aNoteOf = (length) => "x".repeat(length);

describe("purgeEventPayload reasonCode", () => {
  it.each(["BROKEN_PAYLOAD", "SENT_IN_ERROR"])(
    "accepts %s on its own, with no note",
    (reasonCode) => {
      expect(errorOf({ reasonCode })).toBeUndefined();
    },
  );

  it("requires a reason - a purge is a decision someone has to own", () => {
    expect(errorOf({})).toBeDefined();
    expect(errorOf({ note: "a note but no code" })).toBeDefined();
  });

  it("rejects a code outside the fixed set", () => {
    expect(errorOf({ reasonCode: "DONT_LIKE_IT" })).toBeDefined();
    expect(errorOf({ reasonCode: "broken_payload" })).toBeDefined();
    expect(errorOf({ reasonCode: "" })).toBeDefined();
  });

  it("rejects a key nobody asked for", () => {
    expect(
      errorOf({ reasonCode: "SENT_IN_ERROR", status: "COMPLETED" }),
    ).toBeDefined();
  });
});

describe("purgeEventPayload note when the reason is OTHER", () => {
  it("requires a note", () => {
    expect(errorOf({ reasonCode: "OTHER" })).toBeDefined();
  });

  it("treats an empty, whitespace-only or null note as no note at all", () => {
    expect(errorOf({ reasonCode: "OTHER", note: "" })).toBeDefined();
    expect(errorOf({ reasonCode: "OTHER", note: "   " })).toBeDefined();
    expect(errorOf({ reasonCode: "OTHER", note: null })).toBeDefined();
  });

  it("accepts a note", () => {
    expect(
      errorOf({ reasonCode: "OTHER", note: "asked for by the grant team" }),
    ).toBeUndefined();
  });
});

describe("purgeEventPayload note when the reason is not OTHER", () => {
  it("does not require the key at all", () => {
    expect(errorOf({ reasonCode: "BROKEN_PAYLOAD" })).toBeUndefined();
    expect(valueOf({ reasonCode: "BROKEN_PAYLOAD" })).not.toHaveProperty(
      "note",
    );
  });

  it("reads a blank note the same way, as absent", () => {
    expect(valueOf({ reasonCode: "BROKEN_PAYLOAD", note: "" })).toEqual({
      reasonCode: "BROKEN_PAYLOAD",
    });
  });

  // A caller that serialises an empty box as null means "no note", not a 400.
  it("reads a null note the same way, as absent", () => {
    expect(valueOf({ reasonCode: "BROKEN_PAYLOAD", note: null })).toEqual({
      reasonCode: "BROKEN_PAYLOAD",
    });
  });

  it("keeps a note when there is one", () => {
    expect(
      valueOf({ reasonCode: "BROKEN_PAYLOAD", note: "no caseRef" }).note,
    ).toBe("no caseRef");
  });

  it("trims the surrounding whitespace off a note", () => {
    expect(
      valueOf({ reasonCode: "SENT_IN_ERROR", note: "  duplicate  " }).note,
    ).toBe("duplicate");
  });
});

describe("purgeEventPayload note length", () => {
  it("accepts a note of exactly the maximum length", () => {
    expect(
      errorOf({
        reasonCode: "OTHER",
        note: aNoteOf(PURGE_NOTE_MAX_LENGTH),
      }),
    ).toBeUndefined();
  });

  it("rejects one character more", () => {
    expect(
      errorOf({
        reasonCode: "OTHER",
        note: aNoteOf(PURGE_NOTE_MAX_LENGTH + 1),
      }),
    ).toBeDefined();
  });

  it("measures the trimmed note, not the typed one", () => {
    expect(
      errorOf({
        reasonCode: "OTHER",
        note: `  ${aNoteOf(PURGE_NOTE_MAX_LENGTH)}  `,
      }),
    ).toBeUndefined();
  });

  it("rejects a note that is not a string", () => {
    expect(errorOf({ reasonCode: "OTHER", note: 42 })).toBeDefined();
    expect(errorOf({ reasonCode: "BROKEN_PAYLOAD", note: 42 })).toBeDefined();
  });
});
