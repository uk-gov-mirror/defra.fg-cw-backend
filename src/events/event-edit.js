import Boom from "@hapi/boom";
import { REDRIVABLE_STATUSES } from "./event-redrive.js";
import { payloadChanges, payloadHash } from "./payload-changes.js";
import { isPlainObject } from "./plain-json.js";

export const EDIT_NOTE_MAX = 500;

// Measured pretty-printed, as the admin shows it. The row holds the payload
// twice once edited, and the admin renders it a line at a time.
export const PAYLOAD_MAX_BYTES = 256 * 1024;

export const TOO_LARGE = "TOO_LARGE";
export const UNCHANGED = "UNCHANGED";
export const NOT_AN_OBJECT = "NOT_AN_OBJECT";
export const DOLLAR_KEY = "DOLLAR_KEY";

// Why a save was refused, as a FAILURE audit event records it.
export const NOT_FOUND = "NOT_FOUND";
export const NOT_EDITABLE = "NOT_EDITABLE";
export const STALE = "STALE";

// The messages name the rule, never the payload.
const REFUSAL_MESSAGES = {
  [TOO_LARGE]: `The payload is over ${PAYLOAD_MAX_BYTES} bytes pretty-printed`,
  [UNCHANGED]: "The payload is the same as the stored one",
  [NOT_AN_OBJECT]: "The payload is not a JSON object",
  [DOLLAR_KEY]: "The payload has a key starting with $, which cannot be stored",
};

export const editRefusal = (reason) => {
  const error = Boom.badData(REFUSAL_MESSAGES[reason]);

  error.output.payload.reason = reason;

  return error;
};

// The same body shape as `redriveConflict`, in an edit's own words.
export const editConflict = (box, id, status) => {
  const error = Boom.conflict(
    `${box} event "${id}" is ${status}, not editable (${REDRIVABLE_STATUSES.join(" or ")})`,
  );

  error.output.payload.status = status;

  return error;
};

const FAILURE_REASONS_BY_STATUS = {
  404: () => NOT_FOUND,
  409: () => NOT_EDITABLE,
  412: () => STALE,
  422: (payload) => payload?.reason ?? null,
};

// Null for a failure that is not a refusal.
export const editFailureReason = (error) => {
  const reasonOf = FAILURE_REASONS_BY_STATUS[error?.output?.statusCode];

  return reasonOf ? reasonOf(error.output.payload) : null;
};

export const staleEdit = (box, id) =>
  Boom.preconditionFailed(
    `${box} event "${id}" was edited since the given revision`,
  );

const isDollarKey = (key) => key.startsWith("$");

const hasDollarKey = (value) => {
  if (Array.isArray(value)) {
    return value.some(hasDollarKey);
  }

  return (
    isPlainObject(value) &&
    (Object.keys(value).some(isDollarKey) ||
      Object.values(value).some(hasDollarKey))
  );
};

const isTooLarge = (payload) =>
  Buffer.byteLength(JSON.stringify(payload, null, 2)) > PAYLOAD_MAX_BYTES;

// In order: the size is only measured once the payload is known to be one.
const REFUSALS = [
  [NOT_AN_OBJECT, (payload) => !isPlainObject(payload)],
  [DOLLAR_KEY, hasDollarKey],
  [TOO_LARGE, isTooLarge],
];

const refusalOf = (payload) =>
  REFUSALS.find(([, refuses]) => refuses(payload))?.[0];

// What the audit event records about an edit: where it landed and the hashes
// either side, never a value.
export const checkEdit = (stored, payload) => {
  const reason = refusalOf(payload);

  if (reason) {
    throw editRefusal(reason);
  }

  const changes = payloadChanges(stored, payload);

  if (changes.changedPaths.length === 0) {
    throw editRefusal(UNCHANGED);
  }

  return {
    ...changes,
    beforeHash: payloadHash(stored),
    afterHash: payloadHash(payload),
  };
};

// A refused save changed nothing, so it names only why it was refused.
export const auditedEdit = (result, error) =>
  result
    ? {
        changedPaths: result.changedPaths,
        changedPathsTruncated: result.changedPathsTruncated,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
      }
    : { reason: editFailureReason(error) };

// A row never edited has no counter, and `null` matches a missing field.
export const editFence = (revision) => ({
  status: { $in: REDRIVABLE_STATUSES },
  payloadRevision: revision === 0 ? null : revision,
});

// None of these fields is in a model, so a poller's `$set` never names them
// and cannot erase them. The original is given on the first edit only and
// stays for the row's lifetime; not keyed on revision 0, as a purge or a
// redrive moves the revision on too.
export const editUpdate = ({
  event,
  by,
  note,
  revision,
  original,
  inboxColumns,
  at,
}) => ({
  $set: {
    event,
    payloadRevision: revision + 1,
    lastEdit: { at: (at ?? new Date()).toISOString(), by: by ?? null, note },
    ...(original !== undefined && { originalPayload: original }),
    ...inboxColumns,
  },
});
