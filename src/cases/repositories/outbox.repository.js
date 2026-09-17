import { actuatorBoxQueries, orNull } from "./actuator-box.repository.js";
import { config } from "../../common/config.js";
import { isAuditTarget, typeLabel } from "../../events/event-audit.js";
import {
  claimExpiredAttempt,
  claimExpiredError,
  pushAttemptUpdate,
} from "../../events/last-error.js";
import { logger } from "../../common/logger.js";
import { db } from "../../common/mongo-client.js";
import { Outbox, OutboxStatus } from "../models/outbox.js";

const collection = "outbox";

const MAX_RETRIES = parseInt(config.get("outbox.outboxMaxRetries"));
const EXPIRES_IN_MS = parseInt(config.get("outbox.outboxExpiresMs"));
const NUMBER_OF_RECORDS = parseInt(config.get("outbox.outboxClaimMaxRecords"));

export const findNextMessage = async (lockIds) => {
  const doc = await db.collection(collection).findOne(
    {
      status: { $eq: OutboxStatus.PUBLISHED },
      claimedBy: { $eq: null },
      completionAttempts: { $lt: MAX_RETRIES },
      segregationRef: { $nin: lockIds },
    },
    { sort: { publicationDate: 1 } },
  );
  return doc;
};

export const claimEvents = async (claimedBy, segregationRef) => {
  const docs = [];
  for (let i = 0; i < NUMBER_OF_RECORDS; i++) {
    const document = await db.collection(collection).findOneAndUpdate(
      {
        status: {
          $eq: OutboxStatus.PUBLISHED,
        },
        claimedBy: {
          $eq: null,
        },
        completionAttempts: {
          $lt: MAX_RETRIES,
        },
        segregationRef,
      },
      {
        $set: {
          status: OutboxStatus.PROCESSING,
          claimedBy,
          claimedAt: new Date(),
          claimExpiresAt: new Date(Date.now() + EXPIRES_IN_MS),
        },
      },
      { sort: { publicationDate: 1 }, returnDocument: "after" },
    );
    docs.push(document);
  }
  const documents = docs.filter((d) => d !== null);

  documents?.length &&
    logger.info(`Found "${documents.length}" outbox documents to process.`);

  return documents.map((doc) => Outbox.fromDocument(doc));
};

export const update = async (event, claimedBy) => {
  const document = event.toDocument();
  const { _id, ...updateDoc } = document;

  return db
    .collection(collection)
    .updateOne({ _id, claimedBy }, { $set: updateDoc });
};

export const insertMany = async (events, session) => {
  return db.collection(collection).insertMany(
    events.map((event) => event.toDocument()),
    { session },
  );
};

export const updateExpiredEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      claimExpiresAt: { $lt: new Date() },
      status: { $nin: [OutboxStatus.DEAD_LETTER, OutboxStatus.COMPLETED] },
    },
    {
      $set: {
        status: OutboxStatus.FAILED,
        lastError: claimExpiredError(),
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
      // A sweep never loads the model, so Mongo applies the history cap.
      $push: pushAttemptUpdate(claimExpiredAttempt()),
      $inc: { completionAttempts: 1 },
    },
  );
  return results;
};

export const updateFailedEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      status: OutboxStatus.FAILED,
    },
    {
      $set: {
        status: OutboxStatus.RESUBMITTED,
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
      status: OutboxStatus.RESUBMITTED,
    },
    {
      $set: {
        status: OutboxStatus.PUBLISHED,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
    },
  );
  return results;
};

export const updateDeadEvents = async () => {
  const results = await db.collection(collection).updateMany(
    {
      completionAttempts: { $gte: MAX_RETRIES },
      // COMPLETED is excluded for the same reason as in `updateExpiredEvents`:
      // a success is terminal. The counter counts failures, so a row that
      // succeeded normally sits below the cap and never matches - but lowering
      // `OUTBOX_MAX_RETRIES` puts already-succeeded rows at or above it.
      status: { $nin: [OutboxStatus.DEAD_LETTER, OutboxStatus.COMPLETED] },
    },
    {
      $set: {
        status: OutboxStatus.DEAD_LETTER,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
      },
    },
  );
  return results;
};

export const {
  findPage,
  countFacets,
  findDetailById,
  findStatusById,
  redriveById,
  breakdown,
} = actuatorBoxQueries({
  collection,
  box: "outbox",
  maxRetries: MAX_RETRIES,
  resubmittedStatus: OutboxStatus.RESUBMITTED,
  publicationDateStorage: "date",
  eventIdField: "event.id",
  traceparentField: "event.traceparent",
  rowFields: {
    eventId: { reads: ["event.id"], map: (doc) => orNull(doc.event?.id) },
    // Never null: only this service can recognise its own audit topic.
    type: {
      reads: ["event.type", "target"],
      map: (doc) => typeLabel(doc.event?.type, isAuditTarget(doc.target)),
    },
  },
});
