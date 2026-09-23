import { editInboxEventPayloadRoute } from "./routes/edit-inbox-event-payload.route.js";
import { editOutboxEventPayloadRoute } from "./routes/edit-outbox-event-payload.route.js";
import { findPageRoute } from "./routes/find-page.route.js";
import { getInboxEventRoute } from "./routes/get-inbox-event.route.js";
import { getOutboxEventRoute } from "./routes/get-outbox-event.route.js";
import { purgeInboxEventRoute } from "./routes/purge-inbox-event.route.js";
import { purgeOutboxEventRoute } from "./routes/purge-outbox-event.route.js";
import { redriveInboxEventRoute } from "./routes/redrive-inbox-event.route.js";
import { redriveOutboxEventRoute } from "./routes/redrive-outbox-event.route.js";

export const actuators = {
  name: "actuators",
  register(server) {
    // ROUTE ORDER - nothing here can be confused for anything else. The
    // `/actuators/events` prefix puts the collection at one depth and its
    // members at another, so no literal segment sits where an `{id}` could be
    // read. `{id}` is constrained to 24 hex characters anyway
    // (schemas/event-id.schema.js), which is what keeps a word out of the
    // detail route; index.test.js asserts both. This note used to explain a
    // real ambiguity, when the page lived at `/actuators/page` alongside
    // `/actuators/<box>/{id}` and the retired counts/breakdown routes - the
    // prefix is what removed it.
    server.route([
      findPageRoute,
      getInboxEventRoute,
      getOutboxEventRoute,
      redriveInboxEventRoute,
      redriveOutboxEventRoute,
      purgeInboxEventRoute,
      purgeOutboxEventRoute,
      editInboxEventPayloadRoute,
      editOutboxEventPayloadRoute,
    ]);
  },
};
