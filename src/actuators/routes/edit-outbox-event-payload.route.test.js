import { describe, expect, it, vi } from "vitest";
import {
  EDIT_PAYLOAD_MAX_BYTES,
  editPayloadRequest,
  failEditValidation,
} from "../schemas/edit-payload.schema.js";
import { editOutboxEventPayloadUseCase } from "../use-cases/edit-outbox-event-payload.use-case.js";
import { editOutboxEventPayloadRoute } from "./edit-outbox-event-payload.route.js";

vi.mock("../use-cases/edit-outbox-event-payload.use-case.js");

const ID = "665f1c2e9a1b2c3d4e5f6a7b";

const { options } = editOutboxEventPayloadRoute;

const aBody = (overrides = {}) => ({
  payload: { id: "evt-1", data: { amount: 12 } },
  note: "amount was a string",
  revision: 0,
  ...overrides,
});

const handle = async (request = {}) => {
  editOutboxEventPayloadUseCase.mockResolvedValue({
    payloadRevision: 1,
    changedPaths: ["/data/amount"],
    changedPathsTruncated: false,
    beforeHash: "before",
    afterHash: "after",
  });

  return editOutboxEventPayloadRoute.handler({
    params: { id: ID },
    query: { by: "donatas" },
    payload: aBody(),
    auth: { credentials: { service: "fg-gas-backend" } },
    ...request,
  });
};

describe("editOutboxEventPayloadRoute", () => {
  it("is a POST on /actuators/events/outbox/{id}/payload", () => {
    expect(editOutboxEventPayloadRoute.method).toBe("POST");
    expect(editOutboxEventPayloadRoute.path).toBe(
      "/actuators/events/outbox/{id}/payload",
    );
  });

  it("is on the public-api strategy, tagged for the public API", () => {
    expect(options.auth).toBe("public-api");
    expect(options.tags).toEqual(["api", "public-api"]);
  });

  it("rejects an id that is not a 24-hex ObjectId", () => {
    expect(
      options.validate.params.validate({ id: "../../etc" }).error,
    ).toBeDefined();
  });

  it("validates the body against the shared edit schema", () => {
    expect(options.validate.payload).toBe(editPayloadRequest);
  });

  it("logs a refused body without quoting it", () => {
    expect(options.validate.failAction).toBe(failEditValidation);
  });

  it("takes a body big enough for a payload at the bound", () => {
    expect(options.payload.maxBytes).toBe(EDIT_PAYLOAD_MAX_BYTES);
  });

  // An edit is audited under the operator's name, so it cannot be anonymous.
  it("requires an operator, and a blank one is a missing one", () => {
    const validateQuery = (query) => options.validate.query.validate(query);

    expect(validateQuery({}).error).toBeDefined();
    expect(validateQuery({ by: "   " }).error).toBeDefined();
    expect(validateQuery({ by: "ada" }).error).toBeUndefined();
  });

  it("passes the id, the operator, the caller and the body to the use case", async () => {
    await handle();

    expect(editOutboxEventPayloadUseCase).toHaveBeenCalledWith({
      id: ID,
      by: "donatas",
      caller: "fg-gas-backend",
      payload: { id: "evt-1", data: { amount: 12 } },
      note: "amount was a string",
      revision: 0,
    });
  });

  it("records no caller when the request carries no service credentials", async () => {
    await handle({ auth: {} });

    expect(editOutboxEventPayloadUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ caller: null }),
    );
  });

  // The hashes are for the audit event; the caller gets the revision to post
  // next time and where the edit landed.
  it("answers the new revision and the changed paths, not the hashes", async () => {
    expect(await handle()).toEqual({
      payloadRevision: 1,
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
    });
  });

  it("describes its answer with the response schema", async () => {
    expect(
      options.response.schema.validate(await handle()).error,
    ).toBeUndefined();
  });
});
