import Joi from "joi";

const lastError = Joi.object({
  name: Joi.string().required().example("ClaimExpired"),
  message: Joi.string().allow("").required(),
  at: Joi.string().isoDate().allow(null).required(),
}).label("EventDetailLastError");

const attemptEntry = Joi.object({
  at: Joi.string().isoDate().allow(null).required(),
  name: Joi.string().required().example("ClaimExpired"),
  message: Joi.string().allow("").required(),
  stack: Joi.string().allow(null).required(),
}).label("EventAttempt");

const isoOrNull = Joi.string().isoDate().allow(null);

// `.unknown(true)` so a document written by another version still renders.
const detailCommon = {
  _id: Joi.string().required(),
  type: Joi.string().required().example("audit"),
  status: Joi.string()
    .required()
    .example("DEAD_LETTER")
    .description(
      "PUBLISHED|PROCESSING|FAILED|RESUBMITTED|COMPLETED|DEAD_LETTER|PURGED",
    ),
  completionAttempts: Joi.number().integer().allow(null),
  maxAttempts: Joi.number().integer().required(),
  segregationRef: Joi.string().allow(null),
  event: Joi.object().unknown(true).allow(null).required(),
  lastError: lastError.allow(null),
  attemptHistory: Joi.array().items(attemptEntry).required(),
  lastRedrive: Joi.object({ at: isoOrNull, by: Joi.string().allow(null) })
    .allow(null)
    .label("EventDetailLastRedrive"),
  lastResubmissionDate: isoOrNull,
  completionDate: isoOrNull,
  publicationDate: isoOrNull,
  expireAt: isoOrNull,
  // Kept through a later redrive, so the admin can say "Previously purged".
  lastPurge: Joi.object({
    at: isoOrNull,
    by: Joi.string().allow(null),
    reasonCode: Joi.string().allow(null),
    note: Joi.string().allow(null),
  })
    .allow(null)
    .label("EventDetailLastPurge"),
  // What the deletion date would be if this event were purged now.
  purgeDeletionDate: isoOrNull,
  // The editor posts this back, so a stale save is refused. Its presence is
  // what tells the admin this service can edit a payload.
  payloadRevision: Joi.number().integer().min(0).required(),
  lastEdit: Joi.object({
    at: isoOrNull,
    by: Joi.string().allow(null),
    note: Joi.string().allow(null),
  })
    .allow(null)
    .label("EventDetailLastEdit"),
  // The payload as it was before the first edit; absent on a row never edited.
  originalPayload: Joi.object().unknown(true).allow(null),
  // False when saving through the editor would turn a stored BSON value (a
  // date, an ObjectId, a long) into its JSON form.
  payloadIsPlainJson: Joi.boolean().required(),
  claimedBy: Joi.any().forbidden(),
  claimedAt: Joi.any().forbidden(),
  claimExpiresAt: Joi.any().forbidden(),
};

export const inboxDetailResponseSchema = Joi.object({
  ...detailCommon,
  messageId: Joi.string().allow(null),
  source: Joi.string().allow(null),
  traceparent: Joi.string().allow(null),
  eventTime: isoOrNull,
})
  .unknown(true)
  .label("InboxEventDetail");

export const outboxDetailResponseSchema = Joi.object({
  ...detailCommon,
  target: Joi.string().allow(null),
})
  .unknown(true)
  .label("OutboxEventDetail");
