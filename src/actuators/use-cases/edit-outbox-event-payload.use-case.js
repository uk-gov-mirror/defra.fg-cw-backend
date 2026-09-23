import Boom from "@hapi/boom";
import {
  editPayloadById,
  findEditableById,
  findStatusById,
} from "../../cases/repositories/outbox.repository.js";
import {
  auditActions,
  auditEntities,
  buildAuditSecurity,
} from "../../common/audit-constants.js";
import { buildSystemSecurityContext } from "../../common/audit-security-context.js";
import { logger } from "../../common/logger.js";
import { withAudit } from "../../common/with-audit.js";
import { withTransaction } from "../../common/with-transaction.js";
import {
  auditedEdit,
  checkEdit,
  editConflict,
  staleEdit,
} from "../../events/event-edit.js";
import { REDRIVABLE_STATUSES } from "../../events/event-redrive.js";

const notFound = (id) => Boom.notFound(`Outbox event "${id}" not found`);

// Nothing matched the fenced update: one read tells a missing row (404) from
// one in another status (409) and one edited since the editor opened (412).
const refusal = async (id, session) => {
  const status = await findStatusById(id, session);

  if (status === null) {
    return notFound(id);
  }

  if (!REDRIVABLE_STATUSES.includes(status)) {
    logger.warn(`Refused an edit of outbox event "${id}" - it is ${status}`);

    return editConflict("Outbox", id, status);
  }

  logger.warn(`Refused a stale edit of outbox event "${id}"`);

  return staleEdit("Outbox", id);
};

const editOutboxEventPayload = async (
  { id, by, payload, note, revision },
  session,
) => {
  logger.info(
    `Editing the payload of outbox event "${id}" from revision ${revision} for ${by}`,
  );

  const stored = await findEditableById(id, session);

  if (stored === null) {
    throw notFound(id);
  }

  const changes = checkEdit(stored.event, payload);

  if (
    await editPayloadById(id, {
      event: payload,
      by,
      note,
      revision,
      original: stored.lastEdit ? undefined : stored.event,
      session,
    })
  ) {
    logger.info(
      `Finished: Editing the payload of outbox event "${id}", now at revision ${revision + 1}`,
    );

    return { payloadRevision: revision + 1, ...changes };
  }

  throw await refusal(id, session);
};

// GAS audits the operator's request; this audits what this service changed.
// Where the payload changed and its hashes either side travel; the values and
// the note do not.
export const editOutboxEventPayloadAuditBuilder = (
  [{ id, by, caller, revision }],
  result,
  error,
) => ({
  entities: [
    {
      entity: auditEntities.EVENT,
      action: auditActions.EDIT_EVENT_PAYLOAD,
      entityid: id,
    },
  ],
  details: {
    security: buildSystemSecurityContext(),
    event: {
      box: "outbox",
      actor: by ?? null,
      caller: caller ?? null,
      revision,
      ...auditedEdit(result, error),
    },
  },
  security: buildAuditSecurity(auditActions.EDIT_EVENT_PAYLOAD),
  segregationRef: `edit-event-${id}`,
});

// The row update and its audit event commit together, so a failed audit
// leaves the payload as it was.
export const editOutboxEventPayloadUseCase = (command) =>
  withTransaction((session) =>
    withAudit(editOutboxEventPayload, editOutboxEventPayloadAuditBuilder)(
      command,
      session,
    ),
  );
