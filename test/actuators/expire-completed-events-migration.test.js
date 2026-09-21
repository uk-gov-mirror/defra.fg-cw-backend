import { MongoClient, ObjectId } from "mongodb";
import { env } from "node:process";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { logger } from "../../src/common/logger.js";
import { up } from "../../migrations/20260921120000-expire-completed-events.js";

const REF = "MIGRATION-expire-completed-events";
const DAY_MS = 86_400_000;

// The migration's own literals, restated so the test fails if they drift.
const RETENTION_DAYS = 90;
const GRACE_DAYS = 14;

const ALREADY_SCHEDULED = new Date("2099-01-01T00:00:00.000Z");

let client;
let db;
let inbox;
let outbox;

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

const idAt = (date) => ObjectId.createFromTime(date.getTime() / 1000);

const dueInDays = (date) => (new Date(date).getTime() - Date.now()) / DAY_MS;

// A held far-future claim keeps the pollers off the fixtures.
const aDoc = (overrides) => ({
  _id: new ObjectId(),
  segregationRef: REF,
  status: "COMPLETED",
  completionDate: null,
  claimedBy: "test-holder",
  claimExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  ...overrides,
});

const expireAtOf = async (collection, _id) =>
  (await collection.findOne({ _id })).expireAt;

const ttlIndexOf = async (collection) =>
  (await collection.listIndexes().toArray()).find(
    (index) => index.name === "expireAt_ttl",
  );

const loggedLines = (info) => info.mock.calls.map(([line]) => line);

beforeAll(async () => {
  client = await MongoClient.connect(env.MONGO_URI);
  db = client.db();
  inbox = db.collection("inbox");
  outbox = db.collection("outbox");
});

afterAll(async () => {
  await client?.close(true);
});

beforeEach(async () => {
  await inbox.deleteMany({ segregationRef: REF });
  await outbox.deleteMany({ segregationRef: REF });
});

describe("20260921120000-expire-completed-events", () => {
  it.each([
    [
      "an old completion, which lands on the deploy + 14 day floor",
      { completionDate: daysAgo(400).toISOString() },
      GRACE_DAYS,
    ],
    [
      "a recent completion, which lands on completion + 90 days",
      { completionDate: daysAgo(10).toISOString() },
      RETENTION_DAYS - 10,
    ],
    [
      "an explicit null expireAt, the release A straggler",
      { completionDate: daysAgo(20).toISOString(), expireAt: null },
      RETENTION_DAYS - 20,
    ],
    [
      "a garbage completionDate, which falls back to the _id timestamp",
      { _id: idAt(daysAgo(30)), completionDate: "not a date" },
      RETENTION_DAYS - 30,
    ],
    [
      "a string _id and no completionDate, which falls back to now",
      { _id: `${REF}-legacy-string-id` },
      RETENTION_DAYS,
    ],
  ])("schedules %s", async (_name, overrides, expectedDueInDays) => {
    const doc = aDoc(overrides);
    await inbox.insertOne(doc);

    await up(db);

    const expireAt = await expireAtOf(inbox, doc._id);

    expect(expireAt).toBeInstanceOf(Date);
    expect(dueInDays(expireAt)).toBeCloseTo(expectedDueInDays, 2);
  });

  it("schedules outbox events the same way", async () => {
    const doc = aDoc({ completionDate: daysAgo(10).toISOString() });
    await outbox.insertOne(doc);

    await up(db);

    expect(dueInDays(await expireAtOf(outbox, doc._id))).toBeCloseTo(
      RETENTION_DAYS - 10,
      2,
    );
  });

  it("schedules a purged row from its purge time", async () => {
    const info = vi.spyOn(logger, "info");
    const doc = aDoc({
      status: "PURGED",
      completionDate: daysAgo(400).toISOString(),
      lastPurge: { at: daysAgo(10).toISOString() },
      expireAt: null,
    });
    await inbox.insertOne(doc);

    await up(db);

    const expireAt = await expireAtOf(inbox, doc._id);

    expect(expireAt).toBeInstanceOf(Date);
    expect(dueInDays(expireAt)).toBeCloseTo(RETENTION_DAYS - 10, 2);
    expect(loggedLines(info)).toContainEqual(
      expect.stringContaining("inbox events; 0 still unscheduled"),
    );
  });

  it("leaves an already scheduled row alone", async () => {
    const doc = aDoc({
      completionDate: daysAgo(10).toISOString(),
      expireAt: ALREADY_SCHEDULED,
    });
    await inbox.insertOne(doc);

    await up(db);

    expect(await expireAtOf(inbox, doc._id)).toEqual(ALREADY_SCHEDULED);
  });

  it("never schedules a dead letter", async () => {
    const doc = aDoc({
      status: "DEAD_LETTER",
      completionDate: daysAgo(400).toISOString(),
    });
    await inbox.insertOne(doc);

    await up(db);

    expect(await expireAtOf(inbox, doc._id)).toBeUndefined();
  });

  // Strings sort ahead of dates, so an unguarded query would read one back.
  it("never reports a non-Date expireAt as the earliest", async () => {
    const info = vi.spyOn(logger, "info");
    const STRING_EXPIRE_AT = "2029-01-01T00:00:00.000Z";
    const stringRow = aDoc({
      completionDate: daysAgo(10).toISOString(),
      expireAt: STRING_EXPIRE_AT,
    });
    const dateRow = aDoc({
      completionDate: daysAgo(10).toISOString(),
      expireAt: ALREADY_SCHEDULED,
    });
    await inbox.insertMany([stringRow, dateRow]);

    await expect(up(db)).resolves.toBeUndefined();

    expect(await expireAtOf(inbox, stringRow._id)).toBe(STRING_EXPIRE_AT);
    expect(await expireAtOf(inbox, dateRow._id)).toEqual(ALREADY_SCHEDULED);

    const earliest = loggedLines(info)
      .find((line) => line.includes("completed inbox events"))
      .match(/earliest (?<earliest>.+)$/).groups.earliest;

    expect(earliest).not.toBe(STRING_EXPIRE_AT);
    expect(new Date(earliest).toISOString()).toBe(earliest);
  });

  it("is safe to run again", async () => {
    const info = vi.spyOn(logger, "info");
    const doc = aDoc({ completionDate: daysAgo(10).toISOString() });
    await inbox.insertOne(doc);

    await up(db);
    const afterFirstRun = await expireAtOf(inbox, doc._id);

    info.mockClear();
    await up(db);

    expect(await expireAtOf(inbox, doc._id)).toEqual(afterFirstRun);
    expect(loggedLines(info)).toContainEqual(
      expect.stringContaining("Scheduled expiry on 0 completed inbox events"),
    );
  });

  it.each(["inbox", "outbox"])(
    "creates the partial TTL index on %s",
    async (box) => {
      await up(db);

      expect(await ttlIndexOf(db.collection(box))).toMatchObject({
        name: "expireAt_ttl",
        key: { expireAt: 1 },
        expireAfterSeconds: 0,
        partialFilterExpression: {
          status: { $in: ["COMPLETED", "PURGED"] },
        },
      });
    },
  );

  it.each(["inbox", "outbox"])(
    "logs that nothing is left unscheduled in %s, and reads the index back",
    async (box) => {
      const info = vi.spyOn(logger, "info");
      await db
        .collection(box)
        .insertOne(aDoc({ completionDate: daysAgo(10).toISOString() }));

      await up(db);

      expect(loggedLines(info)).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Scheduled expiry on 1 completed ${box} events; 0 still unscheduled; earliest \\d{4}-\\d{2}-\\d{2}T`,
          ),
        ),
      );
      expect(loggedLines(info)).toContainEqual(
        `TTL index expireAt_ttl on ${box}: present, filter {"status":{"$in":["COMPLETED","PURGED"]}}`,
      );
    },
  );

  it("rejects when a conflicting TTL index is already there", async () => {
    await inbox.dropIndex("expireAt_ttl").catch(() => {});
    await inbox.createIndex(
      { expireAt: 1 },
      { name: "expireAt_ttl", expireAfterSeconds: 60 },
    );

    try {
      await expect(up(db)).rejects.toThrow();
    } finally {
      await inbox.dropIndex("expireAt_ttl");
    }
  });
});
