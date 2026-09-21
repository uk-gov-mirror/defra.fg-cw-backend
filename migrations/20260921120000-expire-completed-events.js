import { isDeepStrictEqual } from "node:util";
import { logger } from "../src/common/logger.js";

// A literal, never config: a migration says what it did on the day it ran.
const RETENTION_DAYS = 90;
// Grace, so nothing is deleted for a fortnight and there is time to drop the
// index if anything is wrong.
const GRACE_DAYS = 14;
const DAY_MS = 86_400_000;

const BOXES = ["inbox", "outbox"];

const TTL_INDEX_NAME = "expireAt_ttl";

// The partial filter, not application code, is what keeps a dead letter.
const EXPIRING_STATUSES = ["COMPLETED", "PURGED"];
const TTL_INDEX_KEY = { expireAt: 1 };
const TTL_INDEX_FILTER = { status: { $in: EXPIRING_STATUSES } };

const insertedAt = {
  $convert: { input: "$_id", to: "date", onError: "$$NOW", onNull: "$$NOW" },
};

// A garbage or absent `completionDate` falls back to the row's insertion time,
// and a string `_id` that converts to nothing falls back again to now.
const completedAt = {
  $convert: {
    input: "$completionDate",
    to: "date",
    onError: insertedAt,
    onNull: insertedAt,
  },
};

const purgedAt = {
  $convert: {
    input: "$lastPurge.at",
    to: "date",
    onError: insertedAt,
    onNull: insertedAt,
  },
};

const endedAt = {
  $cond: [{ $eq: ["$status", "PURGED"] }, purgedAt, completedAt],
};

// `expireAt: null` matches a missing field and an explicit null alike;
// `$exists: false` would miss the explicit null, which would never expire.
const UNSCHEDULED = { status: { $in: EXPIRING_STATUSES }, expireAt: null };

const scheduleExpiry = (collection, floor) =>
  collection.updateMany(UNSCHEDULED, [
    {
      $set: {
        expireAt: {
          $max: [{ $add: [endedAt, RETENTION_DAYS * DAY_MS] }, floor],
        },
      },
    },
  ]);

// Re-creating an identical index is a no-op, so this is safe to run twice.
const createTtlIndex = (collection) =>
  collection.createIndex(TTL_INDEX_KEY, {
    name: TTL_INDEX_NAME,
    expireAfterSeconds: 0,
    partialFilterExpression: TTL_INDEX_FILTER,
  });

const countUnscheduled = (collection) => collection.countDocuments(UNSCHEDULED);

// `$type: "date"` rather than `$ne: null`: only a BSON Date is ever deleted by
// the TTL index, and only a BSON Date can be turned into an ISO string here.
const earliestExpiry = async (collection) => {
  const doc = await collection.findOne(
    { status: { $in: EXPIRING_STATUSES }, expireAt: { $type: "date" } },
    { sort: { expireAt: 1 }, projection: { expireAt: 1 } },
  );

  return doc ? doc.expireAt.toISOString() : "none";
};

const findTtlIndex = async (collection) => {
  const indexes = await collection.listIndexes().toArray();

  return indexes.find((index) => index.name === TTL_INDEX_NAME);
};

const ttlIndexProblem = (index) => {
  if (!index) {
    return "is missing";
  }

  if (!isDeepStrictEqual(index.key, TTL_INDEX_KEY)) {
    return `has key ${JSON.stringify(index.key)}`;
  }

  if (index.expireAfterSeconds !== 0) {
    return `has expireAfterSeconds ${index.expireAfterSeconds}`;
  }

  if (!isDeepStrictEqual(index.partialFilterExpression, TTL_INDEX_FILTER)) {
    return `has filter ${JSON.stringify(index.partialFilterExpression ?? null)}`;
  }

  return null;
};

export const up = async (db) => {
  const floor = new Date(Date.now() + GRACE_DAYS * DAY_MS);

  for (const box of BOXES) {
    const collection = db.collection(box);

    const { modifiedCount } = await scheduleExpiry(collection, floor);

    await createTtlIndex(collection);

    const unscheduled = await countUnscheduled(collection);
    const earliest = await earliestExpiry(collection);

    logger.info(
      `Scheduled expiry on ${modifiedCount} completed ${box} events; ${unscheduled} still unscheduled; earliest ${earliest}`,
    );

    const index = await findTtlIndex(collection);
    const filterJson = JSON.stringify(index?.partialFilterExpression ?? null);

    logger.info(
      `TTL index ${TTL_INDEX_NAME} on ${box}: ${index ? "present" : "MISSING"}, filter ${filterJson}`,
    );

    const problem = ttlIndexProblem(index);

    if (problem) {
      throw new Error(`TTL index ${TTL_INDEX_NAME} on ${box} ${problem}`);
    }
  }
};
