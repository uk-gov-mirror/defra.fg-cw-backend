import { HttpCodes } from "../../common/schemas/http-codes.js";
import { requiredActorQuery } from "../schemas/box-query.schema.js";
import { eventIdParams } from "../schemas/event-id.schema.js";
import { purgeEventPayload } from "../schemas/purge-event.schema.js";
import { purgeOutboxEventUseCase } from "../use-cases/purge-outbox-event.use-case.js";

// The operator GAS forwarded, and the service client GAS authenticated as -
// both land in this service's own audit record of the purge. The operator is
// required, so the audit event always names the person the purge was made for.
const actorOf = (request) => ({
  by: request.query.by,
  caller: request.auth.credentials?.service ?? null,
});

export const purgeOutboxEventRoute = {
  method: "POST",
  path: "/actuators/events/outbox/{id}/purge",
  options: {
    description:
      "Let one DEAD_LETTER outbox event go: it becomes PURGED, leaves the dead-letter list and is deleted after the retention period. Names the operator in `by`, which the purge is audited under and so is required. 204 with no body; 400 without an operator or a valid reason; 409 when the row is in any other status.",
    auth: "public-api",
    tags: ["api", "public-api"],
    plugins: {
      "hapi-swagger": { security: [{ serviceToken: [] }] },
    },
    validate: {
      params: eventIdParams,
      query: requiredActorQuery,
      payload: purgeEventPayload,
    },
  },
  async handler(request, h) {
    await purgeOutboxEventUseCase({
      id: request.params.id,
      ...actorOf(request),
      reasonCode: request.payload.reasonCode,
      // Validation turns an empty or null note into an absent one; the row
      // stores null.
      note: request.payload.note ?? null,
    });

    return h.response().code(HttpCodes.NoContent);
  },
};
