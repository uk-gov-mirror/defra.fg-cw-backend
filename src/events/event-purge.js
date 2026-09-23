import Boom from "@hapi/boom";
import { config } from "../common/config.js";
import { DEAD_LETTER } from "./event-redrive.js";
import { expiryFrom } from "./event-retention.js";

// Purging is a decision, not a failure. The row keeps its payload and its
// history until the deletion date, so a redrive can still undo it.
export const PURGED = "PURGED";

// Fixed codes rather than free text, so the Purged view can group by reason.
export const BROKEN_PAYLOAD = "BROKEN_PAYLOAD";
export const SENT_IN_ERROR = "SENT_IN_ERROR";
export const OTHER = "OTHER";

export const PURGE_REASON_CODES = [BROKEN_PAYLOAD, SENT_IN_ERROR, OTHER];

export const PURGE_NOTE_MAX_LENGTH = 500;

const RETENTION_DAYS = config.get("events.retentionDays");

// An ISO string, like `lastRedrive.at`: this service only serialises top-level
// Dates, so a nested BSON Date would reach the wire as an object.
const purgeRecord = ({ by, reasonCode, note }, at) => ({
  at: at.toISOString(),
  by: by ?? null,
  reasonCode,
  note: note ?? null,
});

export const purgeUpdate = ({ by, reasonCode, note, at } = {}) => {
  const now = at ?? new Date();

  return {
    $set: {
      status: PURGED,
      lastPurge: purgeRecord({ by, reasonCode, note }, now),
      // A BSON Date: a TTL index silently ignores any other type.
      expireAt: expiryFrom(now, RETENTION_DAYS),
    },
    // An editor opened before the purge must not save onto the purged row.
    $inc: { payloadRevision: 1 },
  };
};

// The same body shape as `redriveConflict` - GAS maps both onto one outcome.
export const purgeConflict = (box, id, status) => {
  const error = Boom.conflict(
    `${box} event "${id}" is ${status}, not ${DEAD_LETTER}`,
  );

  error.output.payload.status = status;

  return error;
};
