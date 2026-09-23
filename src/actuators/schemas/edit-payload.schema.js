import Joi from "joi";
import { logger } from "../../common/logger.js";
import { EDIT_NOTE_MAX, PAYLOAD_MAX_BYTES } from "../../events/event-edit.js";

// Room for the note and the other two fields beside a payload at the bound,
// so a body whose payload is within it never meets a 413.
export const EDIT_PAYLOAD_MAX_BYTES = PAYLOAD_MAX_BYTES + 16 * 1024;

// `unknown(true)` and no keys, so no validation message can quote a value.
export const editPayloadRequest = Joi.object({
  payload: Joi.object()
    .unknown(true)
    .required()
    .description("the whole replacement event, as a JSON object"),
  note: Joi.string()
    .trim()
    .min(1)
    .max(EDIT_NOTE_MAX)
    .required()
    .example("amount was sent as a string by the retired form")
    .description(
      `why the payload was edited, at most ${EDIT_NOTE_MAX} characters`,
    ),
  revision: Joi.number()
    .integer()
    .min(0)
    .required()
    .example(0)
    .description("the payloadRevision the edit was made from"),
}).label("EditPayloadRequest");

export const editPayloadResponse = Joi.object({
  payloadRevision: Joi.number().integer().min(1).required(),
  changedPaths: Joi.array()
    .items(Joi.string().allow(""))
    .required()
    .description("JSON Pointers to what changed, never the values"),
  changedPathsTruncated: Joi.boolean().required(),
}).label("EditPayloadResponse");

// The server-wide failAction logs the whole Joi error, and that carries the
// request body: the payload and the note.
export const failEditValidation = (_request, _h, error) => {
  logger.warn(`Refused a payload edit request: ${error.message}`);

  throw error;
};
