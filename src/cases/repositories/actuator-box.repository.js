import { ObjectId } from "mongodb";
import { config } from "../../common/config.js";
import { db } from "../../common/mongo-client.js";
import {
  dateCodec,
  objectIdCodec,
  paginate,
  stringCodec,
} from "../../common/paginate.js";
import {
  AUDIT_TARGET_FIELDS,
  EVENT_TYPE_FIELDS,
  auditGroupExpression,
} from "../../events/event-audit.js";
import {
  breakdownStages,
  toBreakdownGroups,
} from "../../events/event-breakdown.js";
import { toDetailDocument } from "../../events/event-detail.js";
import { toSourceFacets } from "../../events/event-facets.js";
import { buildEventListFilter } from "../../events/event-list-filter.js";
import { purgeUpdate } from "../../events/event-purge.js";
import {
  DEAD_LETTER,
  REDRIVABLE_STATUSES,
  redriveUpdate,
} from "../../events/event-redrive.js";
import { toIsoOrNull } from "../../common/date-helpers.js";
import { statusGroupStage } from "../../events/status-counts.js";

const SORT_KEY = "publicationDate";

const toId = (id) => ObjectId.createFromHexString(id);

// Every read here is bounded, so one that outlives its caller's HTTP timeout
// stops on the server rather than running on.
const maxTimeMS = () => config.get("mongo.actuatorReadMaxTimeMs");

export const orNull = (value) => value ?? null;

// Projected away so they never leave the database: `claimedBy` is a live claim
// token, and the claim times are poller internals.
const DETAIL_PROJECTION = { claimedBy: 0, claimedAt: 0, claimExpiresAt: 0 };

const STORAGE = {
  string: { codec: stringCodec, rangeIsDate: false },
  date: { codec: dateCodec, rangeIsDate: true },
};

// Each list-row field names the stored fields it reads, so the projection is
// derived from the row and adding a field is one edit.
const SHARED_ROW_FIELDS = {
  status: { reads: ["status"], map: (doc) => doc.status },
  [SORT_KEY]: { reads: [SORT_KEY], map: (doc) => toIsoOrNull(doc[SORT_KEY]) },
  completedAt: {
    reads: ["completionDate"],
    map: (doc) => toIsoOrNull(doc.completionDate),
  },
};

const assertNoSharedField = (rowFields) => {
  const clash = Object.keys(rowFields).find(
    (name) => name === "_id" || Object.hasOwn(SHARED_ROW_FIELDS, name),
  );

  if (clash) {
    throw new Error(`Row field "${clash}" is already a shared row field`);
  }
};

const listRowOf = (rowFields) => {
  assertNoSharedField(rowFields);

  const fields = Object.entries({ ...rowFields, ...SHARED_ROW_FIELDS });

  return {
    project: Object.fromEntries([
      ["_id", 1],
      ...fields.flatMap(([, { reads }]) => reads.map((read) => [read, 1])),
    ]),
    toListRow: (doc) => ({
      _id: doc._id.toHexString(),
      ...Object.fromEntries(fields.map(([name, { map }]) => [name, map(doc)])),
    }),
  };
};

const listFilterFor =
  ({ box, publicationDateStorage, eventIdField, traceparentField }) =>
  (query) =>
    buildEventListFilter({
      ...query,
      eventIdField,
      traceparentField,
      targetField: AUDIT_TARGET_FIELDS[box],
      rangeField: SORT_KEY,
      rangeIsDate: STORAGE[publicationDateStorage].rangeIsDate,
    });

const findPageFor = (
  { collection, publicationDateStorage, rowFields },
  listFilter,
) => {
  // The caller builds each cursor as base64url JSON `{ publicationDate, _id }`
  // from the last row it took; see common/paginate.js.
  const codecs = {
    [SORT_KEY]: STORAGE[publicationDateStorage].codec,
    _id: objectIdCodec,
  };
  const { project, toListRow } = listRowOf(rowFields);

  return ({ cursor, pageSize, ...query }) =>
    paginate(db.collection(collection), {
      filter: listFilter(query),
      cursor,
      sort: { [SORT_KEY]: -1, _id: -1 },
      pageSize,
      withTotal: false,
      codecs,
      project,
      mapDocument: toListRow,
      maxTimeMS: maxTimeMS(),
    });
};

// No cursor, so the figures do not move as the operator pages.
const countFacetsFor =
  ({ collection }, listFilter) =>
  async (filter = {}) =>
    toSourceFacets(
      await db
        .collection(collection)
        .aggregate([{ $match: listFilter(filter) }, statusGroupStage()], {
          maxTimeMS: maxTimeMS(),
        })
        .toArray(),
    );

const findDetailByIdFor =
  ({ collection, box, maxRetries }) =>
  async (id) => {
    const doc = await db
      .collection(collection)
      .findOne(
        { _id: toId(id) },
        { projection: DETAIL_PROJECTION, maxTimeMS: maxTimeMS() },
      );

    return doc ? toDetailDocument(doc, maxRetries, box) : null;
  };

// `session` makes this read see the same state as the redrive's failed match.
const findStatusByIdFor =
  ({ collection }) =>
  async (id, session) => {
    const doc = await db
      .collection(collection)
      .findOne(
        { _id: toId(id) },
        { projection: { status: 1 }, session, maxTimeMS: maxTimeMS() },
      );

    return doc ? doc.status : null;
  };

// The status filter is the precondition, so a concurrent change is a 409.
const redriveByIdFor =
  ({ collection, resubmittedStatus }) =>
  async (id, { by, session } = {}) => {
    const { matchedCount } = await db
      .collection(collection)
      .updateOne(
        { _id: toId(id), status: { $in: REDRIVABLE_STATUSES } },
        redriveUpdate(resubmittedStatus, { by }),
        { session },
      );

    return matchedCount === 1;
  };

// Fenced on DEAD_LETTER alone: the system has to have given up on a row before
// an operator can.
const purgeByIdFor =
  ({ collection }) =>
  async (id, { by, reasonCode, note, session } = {}) => {
    const { matchedCount } = await db
      .collection(collection)
      .updateOne(
        { _id: toId(id), status: DEAD_LETTER },
        purgeUpdate({ by, reasonCode, note }),
        { session },
      );

    return matchedCount === 1;
  };

const breakdownFor =
  ({ collection, box }, listFilter) =>
  async (filter = {}) =>
    toBreakdownGroups(
      await db
        .collection(collection)
        .aggregate(
          breakdownStages({
            // DEAD_LETTER, not the wider redrivable set: Top errors answers
            // "what still needs attention", and a purged row has been let go.
            filter: listFilter({ ...filter, status: DEAD_LETTER }),
            typeField: EVENT_TYPE_FIELDS[box],
            auditExpression: auditGroupExpression(AUDIT_TARGET_FIELDS[box]),
            sortKey: SORT_KEY,
          }),
          { maxTimeMS: maxTimeMS() },
        )
        .toArray(),
    );

// The admin read and mutation queries both boxes share.
export const actuatorBoxQueries = (boxConfig) => {
  const listFilter = listFilterFor(boxConfig);

  return {
    findPage: findPageFor(boxConfig, listFilter),
    countFacets: countFacetsFor(boxConfig, listFilter),
    findDetailById: findDetailByIdFor(boxConfig),
    findStatusById: findStatusByIdFor(boxConfig),
    redriveById: redriveByIdFor(boxConfig),
    purgeById: purgeByIdFor(boxConfig),
    breakdown: breakdownFor(boxConfig, listFilter),
  };
};
