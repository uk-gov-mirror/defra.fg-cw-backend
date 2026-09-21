import {
  AUDIT_TARGET_FIELDS,
  isAuditTarget,
  typeLabel,
} from "./event-audit.js";
import { config } from "../common/config.js";
import { toIsoOrNull } from "../common/date-helpers.js";
import { DEAD_LETTER } from "./event-redrive.js";
import { expiryFrom } from "./event-retention.js";
import { normaliseAttemptHistory, toStoredLastError } from "./last-error.js";

const DEFAULT_ERROR_NAME = "Error";

const RETENTION_DAYS = config.get("events.retentionDays");

// Only top-level Dates are converted, so `event` stays exactly as stored.
const serialiseValue = (value) =>
  value instanceof Date ? value.toISOString() : value;

const attemptField = (entry, key, fallback) => entry?.[key] ?? fallback;

const attemptStack = (entry) => {
  const stack = attemptField(entry, "stack", null);

  return stack === null ? null : String(stack);
};

const toAttemptEntry = (entry) => ({
  at: toIsoOrNull(attemptField(entry, "at", null)),
  name: String(attemptField(entry, "name", DEFAULT_ERROR_NAME)),
  message: String(attemptField(entry, "message", "")),
  stack: attemptStack(entry),
});

const toAttemptHistory = (history) =>
  normaliseAttemptHistory(history).map(toAttemptEntry);

const INBOX = "inbox";

const storedTypeOf = (doc, box) =>
  (box === INBOX ? doc.type : doc.event?.type) ?? null;

// Rebuilt key by key: a stored Date in `at` would reach the wire as an object.
const orNull = (value) => value ?? null;

const toPurgeRecord = (record) =>
  record
    ? {
        at: toIsoOrNull(record.at),
        by: orNull(record.by),
        reasonCode: orNull(record.reasonCode),
        note: orNull(record.note),
      }
    : null;

// Not stored data: what the deletion date would be if the row were purged now.
// DEAD_LETTER only - on any other status a purge would be refused, so a date
// would promise something untrue.
const toPurgeDeletionDate = (doc, now) =>
  doc.status === DEAD_LETTER
    ? expiryFrom(now, RETENTION_DAYS).toISOString()
    : null;

const isAuditRow = (doc, box) => {
  const targetField = AUDIT_TARGET_FIELDS[box];

  return Boolean(targetField) && isAuditTarget(doc[targetField]);
};

export const toDetailDocument = (doc, maxAttempts, box) => {
  const detail = { maxAttempts };

  for (const [key, value] of Object.entries(doc)) {
    detail[key] = serialiseValue(value);
  }

  detail._id = doc._id.toHexString();
  detail.attemptHistory = toAttemptHistory(doc.attemptHistory);
  // Rebuilt so a stored stack never reaches the wire: response schemas only log.
  detail.lastError = toStoredLastError(doc.lastError);
  detail.lastPurge = toPurgeRecord(doc.lastPurge);
  detail.purgeDeletionDate = toPurgeDeletionDate(doc, new Date());

  // Derived last, so the label wins over any stored `type`.
  detail.type = typeLabel(storedTypeOf(doc, box), isAuditRow(doc, box));

  return detail;
};
