import Joi from "joi";
import { PAGE_SECTIONS } from "../../common/actuator-page-sections.js";
import { AUDIT_EXCLUDE, AUDIT_MODES } from "../../events/event-audit.js";
import { EVENT_STATUSES } from "../../events/status-counts.js";

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MIN_Q = 1;
const MAX_Q = 200;
const MIN_ERROR = 1;
// The stored `lastError.message` cap, so any stored message can be filtered on.
const MAX_ERROR = 1024;
const MAX_ACTOR = 128;

const SECTIONS_PATTERN = new RegExp(
  `^(${PAGE_SECTIONS.join("|")})(,(${PAGE_SECTIONS.join("|")}))*$`,
);

const Q_DESCRIPTION =
  "exact messageId (inbox) or event id (outbox), exact _id, exact traceparent, exact event.data.caseRef or event.data.clientRef, or an exact/prefix segregationRef";

const isAfter = (from, to) => Date.parse(from) > Date.parse(to);

// Compared as instants: "...T00:00:00Z" and "...T01:00:00+02:00" sort the
// other way round as strings.
const assertRange = (value, helpers) => {
  if (value.from && value.to && isAfter(value.from, value.to)) {
    return helpers.error("any.invalid");
  }

  return value;
};

const RANGE_MESSAGES = {
  "any.invalid": '"from" must be earlier than or equal to "to"',
};

const selection = () => ({
  // Whitespace-only is treated as absent, so clearing the box is not a 400.
  q: Joi.string()
    .trim()
    .min(MIN_Q)
    .max(MAX_Q)
    .empty("")
    .description(Q_DESCRIPTION),
  // Exact, because the value is clicked out of a breakdown group.
  error: Joi.string()
    .trim()
    .min(MIN_ERROR)
    .max(MAX_ERROR)
    .empty("")
    .description("exact stored lastError.message"),
  from: Joi.string()
    .isoDate()
    .example("2026-06-16T00:00:00.000Z")
    .description("inclusive lower bound on publicationDate"),
  to: Joi.string()
    .isoDate()
    .example("2026-06-16T23:59:59.999Z")
    .description("inclusive upper bound on publicationDate"),
  // Defaults to exclude: an audit record is neither work that moved nor failed.
  audit: Joi.string()
    .valid(...AUDIT_MODES)
    .default(AUDIT_EXCLUDE)
    .example("include")
    .description("whether audit records are included in the selection"),
});

// One cursor per box: the caller's merged cursor holds a position per source.
export const pageQuery = Joi.object({
  inboxCursor: Joi.string(),
  outboxCursor: Joi.string(),
  pageSize: Joi.number()
    .integer()
    .min(MIN_PAGE_SIZE)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  status: Joi.string().valid(...EVENT_STATUSES),
  // A section left out is not queried and answers null.
  sections: Joi.string()
    .pattern(SECTIONS_PATTERN)
    .custom((value) => [...new Set(value.split(","))])
    .default(PAGE_SECTIONS)
    .example("list,counts")
    .description("comma list of list, counts, breakdown; all when absent"),
  ...selection(),
})
  .custom(assertRange)
  .messages(RANGE_MESSAGES)
  .label("ActuatorPageQuery");

// The operator GAS forwarded from `x-actor`; this service never invents one.
const actor = () =>
  Joi.string()
    .trim()
    .max(MAX_ACTOR)
    .empty("")
    .description("operator the mutation is made on behalf of");

export const actorQuery = Joi.object({ by: actor() }).label("ActorQuery");

// For a mutation audited under the operator's name, which cannot then be
// anonymous. `empty("")` makes a blank one absent, and absent fails `required`.
export const requiredActorQuery = Joi.object({
  by: actor().required(),
}).label("RequiredActorQuery");
