import { describe, expect, it, vi } from "vitest";
import { logger } from "../../common/logger.js";
import {
  EDIT_PAYLOAD_MAX_BYTES,
  editPayloadRequest,
  editPayloadResponse,
  failEditValidation,
} from "./edit-payload.schema.js";

vi.mock("../../common/logger.js", () => ({
  logger: { warn: vi.fn() },
}));

const aRequest = (overrides = {}) => ({
  payload: { id: "evt-1", data: { amount: 12 } },
  note: "amount was a string",
  revision: 0,
  ...overrides,
});

const errorOf = (body) => editPayloadRequest.validate(body).error;

describe("editPayloadRequest", () => {
  it("is labelled EditPayloadRequest", () => {
    expect(editPayloadRequest.describe().flags.label).toBe(
      "EditPayloadRequest",
    );
  });

  it("accepts a payload, a note and a revision", () => {
    expect(errorOf(aRequest())).toBeUndefined();
  });

  it.each(["payload", "note", "revision"])("requires %s", (field) => {
    const { [field]: _, ...without } = aRequest();

    expect(errorOf(without)).toBeDefined();
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "{}"],
  ])("rejects %s as the payload", (_, payload) => {
    expect(errorOf(aRequest({ payload }))).toBeDefined();
  });

  it("accepts any keys inside the payload", () => {
    expect(
      errorOf(aRequest({ payload: { anything: { at: ["all"] } } })),
    ).toBeUndefined();
  });

  it("trims the note", () => {
    expect(
      editPayloadRequest.validate(aRequest({ note: "  why  " })).value.note,
    ).toBe("why");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["501 characters", "x".repeat(501)],
    ["null", null],
  ])("rejects a note that is %s", (_, note) => {
    expect(errorOf(aRequest({ note }))).toBeDefined();
  });

  it("accepts a note of exactly 500 characters", () => {
    expect(errorOf(aRequest({ note: "x".repeat(500) }))).toBeUndefined();
  });

  it.each([-1, 1.5, "x", null])("rejects a revision of %s", (revision) => {
    expect(errorOf(aRequest({ revision }))).toBeDefined();
  });

  it("rejects a field it does not know", () => {
    expect(errorOf(aRequest({ status: "COMPLETED" }))).toBeDefined();
  });

  it("never quotes a value in a validation message", () => {
    const { error } = editPayloadRequest.validate(
      {
        payload: "Ada Lovelace",
        note: "Grace Hopper".repeat(50),
        revision: "Alan Turing",
      },
      { abortEarly: false },
    );

    expect(error.message).not.toMatch(/Ada|Grace|Alan/);
  });

  it("leaves room beside a payload at the bound for the rest of the body", () => {
    expect(EDIT_PAYLOAD_MAX_BYTES).toBe(256 * 1024 + 16 * 1024);
  });
});

describe("editPayloadResponse", () => {
  it("accepts the revision and the changed paths", () => {
    expect(
      editPayloadResponse.validate({
        payloadRevision: 1,
        changedPaths: ["", "/data/amount"],
        changedPathsTruncated: false,
      }).error,
    ).toBeUndefined();
  });
});

describe("failEditValidation", () => {
  // The server-wide failAction logs the error object, whose `_original` is the
  // body - the payload and the note.
  it("logs the message alone and rethrows", () => {
    const { error } = editPayloadRequest.validate(
      aRequest({ payload: { name: "Ada Lovelace" }, note: "x".repeat(501) }),
    );

    expect(() => failEditValidation({}, {}, error)).toThrow(error);
    expect(logger.warn).toHaveBeenCalledWith(
      `Refused a payload edit request: ${error.message}`,
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Ada");
  });
});
