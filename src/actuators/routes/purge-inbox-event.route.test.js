import { describe, expect, it, vi } from "vitest";
import { purgeInboxEventUseCase } from "../use-cases/purge-inbox-event.use-case.js";
import { purgeInboxEventRoute } from "./purge-inbox-event.route.js";

vi.mock("../use-cases/purge-inbox-event.use-case.js");

const ID = "665f1c2e9a1b2c3d4e5f6a7b";

const validateParams = (params) =>
  purgeInboxEventRoute.options.validate.params.validate(params);

const validatePayload = (payload) =>
  purgeInboxEventRoute.options.validate.payload.validate(payload);

const validateQuery = (query) =>
  purgeInboxEventRoute.options.validate.query.validate(query);

const handle = async (request) => {
  purgeInboxEventUseCase.mockResolvedValue(undefined);
  const code = vi.fn().mockReturnValue("no-content");
  const h = { response: vi.fn().mockReturnValue({ code }) };

  const result = await purgeInboxEventRoute.handler(
    {
      params: { id: ID },
      query: { by: "donatas" },
      payload: { reasonCode: "BROKEN_PAYLOAD" },
      auth: { credentials: { service: "fg-gas-backend" } },
      ...request,
    },
    h,
  );

  return { result, h, code };
};

describe("purgeInboxEventRoute", () => {
  it("is a POST on /actuators/events/inbox/{id}/purge", () => {
    expect(purgeInboxEventRoute.method).toBe("POST");
    expect(purgeInboxEventRoute.path).toBe(
      "/actuators/events/inbox/{id}/purge",
    );
  });

  it("is on the public-api strategy", () => {
    expect(purgeInboxEventRoute.options.auth).toBe("public-api");
  });

  it("is tagged for the public API surface", () => {
    expect(purgeInboxEventRoute.options.tags).toEqual(["api", "public-api"]);
  });

  it("rejects an id that is not a 24-hex ObjectId", () => {
    expect(validateParams({ id: "../../etc" }).error).toBeDefined();
  });

  it("validates the body against the shared purge payload schema", () => {
    expect(validatePayload({}).error).toBeDefined();
    expect(validatePayload({ reasonCode: "NOPE" }).error).toBeDefined();
    expect(
      validatePayload({ reasonCode: "BROKEN_PAYLOAD" }).error,
    ).toBeUndefined();
  });

  it("reads a null note as an absent one rather than a 400", () => {
    const { error, value } = validatePayload({
      reasonCode: "BROKEN_PAYLOAD",
      note: null,
    });

    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty("note");
    expect(
      validatePayload({ reasonCode: "OTHER", note: null }).error,
    ).toBeDefined();
  });

  it("answers 204 with no body", async () => {
    const { result, h, code } = await handle({});

    expect(h.response).toHaveBeenCalledWith();
    expect(code).toHaveBeenCalledWith(204);
    expect(result).toBe("no-content");
  });

  it("passes the id, the reason and the note to the use case", async () => {
    await handle({ payload: { reasonCode: "OTHER", note: "asked for" } });

    expect(purgeInboxEventUseCase).toHaveBeenCalledWith({
      id: ID,
      by: "donatas",
      caller: "fg-gas-backend",
      reasonCode: "OTHER",
      note: "asked for",
    });
  });

  it("turns an absent note into a null one", async () => {
    await handle({ payload: { reasonCode: "SENT_IN_ERROR" } });

    expect(purgeInboxEventUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ note: null }),
    );
  });
});

describe("purgeInboxEventRoute actor", () => {
  it("carries the operator GAS forwarded", async () => {
    await handle({ query: { by: "ada" } });

    expect(purgeInboxEventUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ by: "ada" }),
    );
  });

  // A purge is audited under the operator's name, so an anonymous one would
  // leave a PURGE_EVENT naming nobody. Redrive still takes an absent `by`.
  it("requires an operator", () => {
    expect(validateQuery({}).error).toBeDefined();
    expect(validateQuery({ by: "ada" }).error).toBeUndefined();
  });

  it("refuses a blank operator, which is a missing one spelled differently", () => {
    expect(validateQuery({ by: "" }).error).toBeDefined();
    expect(validateQuery({ by: "   " }).error).toBeDefined();
  });

  it("carries the authenticated service as the caller", async () => {
    await handle({ auth: { credentials: { service: "fg-gas-backend" } } });

    expect(purgeInboxEventUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caller: "fg-gas-backend" }),
    );
  });

  it("records no caller when the request carries no service credentials", async () => {
    await handle({ auth: {} });

    expect(purgeInboxEventUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caller: null }),
    );
  });
});
