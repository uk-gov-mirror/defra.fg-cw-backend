import { requiredActorQuery } from "../schemas/box-query.schema.js";
import {
  EDIT_PAYLOAD_MAX_BYTES,
  editPayloadRequest,
  editPayloadResponse,
  failEditValidation,
} from "../schemas/edit-payload.schema.js";
import { eventIdParams } from "../schemas/event-id.schema.js";
import { editInboxEventPayloadUseCase } from "../use-cases/edit-inbox-event-payload.use-case.js";

export const editInboxEventPayloadRoute = {
  method: "POST",
  path: "/actuators/events/inbox/{id}/payload",
  options: {
    description:
      "Replace the payload of one DEAD_LETTER or PURGED inbox event, leaving its status alone. Names the operator in `by`, which the edit is audited under and so is required. 200 with the new payloadRevision and the changed paths; 404 when there is no such event; 409 naming the row's status when it is in any other; 412 when it was edited since `revision`; 422 with a `reason` of TOO_LARGE, UNCHANGED, NOT_AN_OBJECT or DOLLAR_KEY.",
    auth: "public-api",
    tags: ["api", "public-api"],
    plugins: {
      "hapi-swagger": { security: [{ serviceToken: [] }] },
    },
    payload: { maxBytes: EDIT_PAYLOAD_MAX_BYTES },
    validate: {
      params: eventIdParams,
      query: requiredActorQuery,
      payload: editPayloadRequest,
      failAction: failEditValidation,
    },
    response: {
      schema: editPayloadResponse,
      failAction: "log",
    },
  },
  async handler(request) {
    const { payloadRevision, changedPaths, changedPathsTruncated } =
      await editInboxEventPayloadUseCase({
        id: request.params.id,
        // The operator GAS forwarded, and the service client GAS
        // authenticated as - both land in this service's audit of the edit.
        by: request.query.by,
        caller: request.auth.credentials?.service ?? null,
        payload: request.payload.payload,
        note: request.payload.note,
        revision: request.payload.revision,
      });

    return { payloadRevision, changedPaths, changedPathsTruncated };
  },
};
