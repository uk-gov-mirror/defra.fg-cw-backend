import Joi from "joi";
import {
  OTHER,
  PURGE_NOTE_MAX_LENGTH,
  PURGE_REASON_CODES,
} from "../../events/event-purge.js";

// `empty()` after `trim()` makes a blank or null note absent rather than
// invalid - a caller that serialises "no note" as null means the same thing -
// and absent is then what fails `required()` for OTHER.
export const purgeEventPayload = Joi.object({
  reasonCode: Joi.string()
    .valid(...PURGE_REASON_CODES)
    .required()
    .example(OTHER)
    .description(PURGE_REASON_CODES.join("|")),
  note: Joi.string()
    .trim()
    .empty(Joi.valid("", null))
    .max(PURGE_NOTE_MAX_LENGTH)
    .when("reasonCode", { is: OTHER, then: Joi.required() })
    .example("Duplicate submission from the January load")
    .description(
      `free text of at most ${PURGE_NOTE_MAX_LENGTH} characters; required when reasonCode is ${OTHER}, otherwise optional and stored as null when absent, blank or null`,
    ),
}).label("PurgeEventRequest");
