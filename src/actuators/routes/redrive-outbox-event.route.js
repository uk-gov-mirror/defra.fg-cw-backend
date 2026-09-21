import { HttpCodes } from "../../common/schemas/http-codes.js";
import { actorQuery } from "../schemas/box-query.schema.js";
import { eventIdParams } from "../schemas/event-id.schema.js";
import { redriveOutboxEventUseCase } from "../use-cases/redrive-outbox-event.use-case.js";

export const redriveOutboxEventRoute = {
  method: "POST",
  path: "/actuators/events/outbox/{id}/redrive",
  options: {
    description:
      "Put one DEAD_LETTER or PURGED outbox event back in front of the poller. 204 with no body; 409 naming the row's current status when it is in any other.",
    auth: "public-api",
    tags: ["api", "public-api"],
    plugins: {
      "hapi-swagger": { security: [{ serviceToken: [] }] },
    },
    validate: {
      params: eventIdParams,
      query: actorQuery,
    },
  },
  async handler(request, h) {
    await redriveOutboxEventUseCase({
      id: request.params.id,
      // The operator GAS forwarded, and the service client GAS authenticated
      // as - both land in this service's own audit record of the redrive.
      by: request.query.by ?? null,
      caller: request.auth.credentials?.service ?? null,
    });

    return h.response().code(HttpCodes.NoContent);
  },
};
