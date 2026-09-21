import Boom from "@hapi/boom";

// Without the counter reset the dead-letter sweep re-kills the row before it is
// claimed; the history is cleared with it so attempts never exceed maxAttempts.
const RESET_ATTEMPTS = 0;

export const DEAD_LETTER = "DEAD_LETTER";

// Wider than DEAD_LETTER on purpose: an operator can change their mind about a
// purged row right up until it is deleted.
export const REDRIVABLE_STATUSES = [DEAD_LETTER, "PURGED"];

const redriveRecord = (by, at) => ({
  at: (at ?? new Date()).toISOString(),
  by: by ?? null,
});

// lastError, lastResubmissionDate and lastPurge stay: they record why the row
// died, and what the admin shows as "Previously purged".
export const redriveUpdate = (resubmittedStatus, { by, at } = {}) => ({
  $set: {
    status: resubmittedStatus,
    completionAttempts: RESET_ATTEMPTS,
    attemptHistory: [],
    lastRedrive: redriveRecord(by, at),
    expireAt: null,
    claimedBy: null,
    claimedAt: null,
    claimExpiresAt: null,
  },
});

// The blocking status is in the body so the caller needn't re-read the row.
// The message names the whole set: "not DEAD_LETTER" would lie about a PURGED
// row, which redrives perfectly well.
export const redriveConflict = (box, id, status) => {
  const error = Boom.conflict(
    `${box} event "${id}" is ${status}, not redrivable (${REDRIVABLE_STATUSES.join(" or ")})`,
  );

  error.output.payload.status = status;

  return error;
};
