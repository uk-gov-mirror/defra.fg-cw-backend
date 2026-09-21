import Boom from "@hapi/boom";
import {
  findStatusById,
  purgeById,
} from "../../cases/repositories/inbox.repository.js";
import {
  auditActions,
  auditEntities,
  buildAuditSecurity,
} from "../../common/audit-constants.js";
import { buildSystemSecurityContext } from "../../common/audit-security-context.js";
import { withAudit } from "../../common/with-audit.js";
import { withTransaction } from "../../common/with-transaction.js";
import { purgeConflict } from "../../events/event-purge.js";
import { logger } from "../../common/logger.js";

// Nothing matched the update: one read tells a missing row (404) from one in
// another status (409).
const refusal = async (id, session) => {
  const status = await findStatusById(id, session);

  if (status === null) {
    return Boom.notFound(`Inbox event "${id}" not found`);
  }

  logger.warn(`Refused a purge of inbox event "${id}" - it is ${status}`);

  return purgeConflict("Inbox", id, status);
};

const purgeInboxEvent = async ({ id, by, reasonCode, note }, session) => {
  // Only the log line names a missing operator; the row and audit keep null.
  const actor = by ?? "System";

  logger.info(`Purging inbox event "${id}" for ${actor} as ${reasonCode}`);

  if (await purgeById(id, { by, reasonCode, note, session })) {
    logger.info(`Finished: Purging inbox event "${id}" for ${actor}`);

    return;
  }

  throw await refusal(id, session);
};

// GAS audits the operator's request; this audits what this service changed.
// The reason code travels; the note does not, being free text that can name
// anyone the operator wrote about. The row keeps it until the row is deleted.
export const purgeInboxEventAuditBuilder = ([
  { id, by, caller, reasonCode },
]) => ({
  entities: [
    {
      entity: auditEntities.EVENT,
      action: auditActions.PURGE_EVENT,
      entityid: id,
    },
  ],
  details: {
    security: buildSystemSecurityContext(),
    event: {
      box: "inbox",
      actor: by ?? null,
      caller: caller ?? null,
      reasonCode,
    },
  },
  security: buildAuditSecurity(auditActions.PURGE_EVENT),
  segregationRef: `purge-event-${id}`,
});

// The row update and its audit event commit together, so a failed audit
// leaves the row DEAD_LETTER.
export const purgeInboxEventUseCase = (command) =>
  withTransaction((session) =>
    withAudit(purgeInboxEvent, purgeInboxEventAuditBuilder)(command, session),
  );
