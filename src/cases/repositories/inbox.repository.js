import { actuatorBoxQueries, orNull } from "./actuator-box.repository.js";
import { config } from "../../common/config.js";
import { db } from "../../common/mongo-client.js";
import { typeLabel } from "../../events/event-audit.js";
import {
  claimExpiredAttempt,
  claimExpiredError,
  pushAttemptUpdate,
} from "../../events/last-error.js";
import { Inbox, InboxStatus } from "../models/inbox.js";

const collection = "inbox";
const MAX_RETRIES = parseInt(config.get("inbox.inboxMaxRetries"));
const NUMBER_OF_RECORDS = parseInt(config.get("inbox.inboxClaimMaxRecords"));
const EXPIRES_IN_MS = parseInt(config.get("inbox.inboxExpiresMs"));

export const findNextMessage = async (lockIds) => {
  const doc = await db.collection(collection).findOne(
    {
      status: { $eq: InboxStatus.PUBLISHED },
      claimedBy: { $eq: null },
      completionAttempts: { $lt: MAX_RETRIES },
      segregationRef: { $nin: lockIds },
    },
    { sort: { eventTime: 1 } },
  );
  return doc;
};

export const claimEvents = async (
  claimedBy,
  segregationRef,
  numRecords = NUMBER_OF_RECORDS,
) => {
  const docs = [];

  for (let i = 0; i < numRecords; i++) {
    const document = await db.collection(collection).findOneAndUpdate(
      {
        status: { $eq: InboxStatus.PUBLISHED },
        claimedBy: { $eq: null },
        completionAttempts: { $lt: MAX_RETRIES },
        segregationRef,
      },
      {
        $set: {
          status: InboxStatus.PROCESSING,
          claimedBy,
          claimedAt: new Date(),
          claimExpiresAt: new Date(Date.now() + EXPIRES_IN_MS),
        },
      },
      { sort: { eventTime: 1 }, returnDocument: "after" },
    );
    docs.push(document);
  }

  const documents = docs.filter((d) => d !== null);
  return documents.map((doc) => Inbox.fromDocument(doc));
};

export const processExpiredEvents = async () => {
  await db.collection(collection).updateMany(
    {
      claimExpiresAt: { $lt: new Date() },
      status: {
        $nin: [
          InboxStatus.DEAD_LETTER,
          InboxStatus.COMPLETED,
          InboxStatus.PURGED,
        ],
      },
    },
    {
      $set: {
        status: InboxStatus.FAILED,
        lastError: claimExpiredError(),
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
      // A sweep never loads the model, so Mongo applies the history cap.
      $push: pushAttemptUpdate(claimExpiredAttempt()),
      $inc: { completionAttempts: 1 },
    },
  );
};

export const updateDeadEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      completionAttempts: { $gte: MAX_RETRIES },
      // COMPLETED is excluded for the same reason as in `processExpiredEvents`:
      // a success is terminal. The counter counts failures, so a row that
      // succeeded normally sits below the cap and never matches - but lowering
      // `INBOX_MAX_RETRIES` puts already-succeeded rows at or above it.
      // PURGED is terminal too, and it always sits at the cap - it got there
      // by dying - so without it here the sweep would undo every purge.
      status: {
        $nin: [
          InboxStatus.DEAD_LETTER,
          InboxStatus.COMPLETED,
          InboxStatus.PURGED,
        ],
      },
    },
    {
      $set: {
        status: InboxStatus.DEAD_LETTER,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
    },
  );
  return results;
};

export const updateFailedEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      status: InboxStatus.FAILED,
    },
    {
      $set: {
        status: InboxStatus.RESUBMITTED,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
    },
  );
  return results;
};

export const updateResubmittedEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      status: InboxStatus.RESUBMITTED,
    },
    {
      $set: {
        status: InboxStatus.PUBLISHED,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
    },
  );
  return results;
};

export const insertMany = async (events, session) => {
  return db.collection(collection).insertMany(
    events.map((event) => event.toDocument()),
    { session },
  );
};

export const findByMessageId = async (messageId) => {
  const doc = db.collection(collection).findOne({ messageId });
  return doc;
};

export const insertOne = async (inbox, session) => {
  return db.collection(collection).insertOne(inbox.toDocument(), { session });
};

// Matching on `claimedBy` stops a handler that outlived its claim from
// overwriting the expiry sweep's attempt count and history.
export const update = async (inbox, claimedBy) => {
  const document = inbox.toDocument();
  const { _id, ...updateDoc } = document;

  return db
    .collection(collection)
    .updateOne({ _id, claimedBy }, { $set: updateDoc });
};

// The pollers deliberately keep claiming in `eventTime` order, not `publicationDate`.
export const {
  findPage,
  countFacets,
  findDetailById,
  findStatusById,
  redriveById,
  purgeById,
  breakdown,
} = actuatorBoxQueries({
  collection,
  box: "inbox",
  maxRetries: MAX_RETRIES,
  resubmittedStatus: InboxStatus.RESUBMITTED,
  publicationDateStorage: "string",
  eventIdField: "messageId",
  traceparentField: "traceparent",
  rowFields: {
    eventId: { reads: ["messageId"], map: (doc) => orNull(doc.messageId) },
    type: { reads: ["type"], map: (doc) => typeLabel(doc.type, false) },
  },
});
