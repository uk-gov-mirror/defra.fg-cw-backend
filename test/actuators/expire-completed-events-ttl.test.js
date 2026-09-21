import { MongoClient } from "mongodb";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { up } from "../../migrations/20260921120000-expire-completed-events.js";

// Its own mongod rather than the compose stack, with the TTL monitor wound
// down from its 60 second default so the suite never waits on it.
const IMAGE = "mongo:6.0.13";
const TTL_MONITOR_SECONDS = 1;

const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

const DELETED = ["completed-past", "purged-past"];

const SURVIVORS = [
  "dead-letter-past",
  "resubmitted-past",
  "completed-string-date",
  "completed-null",
  "completed-missing",
  "completed-future",
];

const FIXTURES = [
  { _id: "completed-past", status: "COMPLETED", expireAt: PAST },
  { _id: "purged-past", status: "PURGED", expireAt: PAST },
  { _id: "dead-letter-past", status: "DEAD_LETTER", expireAt: PAST },
  { _id: "resubmitted-past", status: "RESUBMITTED", expireAt: PAST },
  // TTL only understands BSON dates: a string is ignored, not parsed.
  {
    _id: "completed-string-date",
    status: "COMPLETED",
    expireAt: PAST.toISOString(),
  },
  { _id: "completed-null", status: "COMPLETED", expireAt: null },
  { _id: "completed-missing", status: "COMPLETED" },
  { _id: "completed-future", status: "COMPLETED", expireAt: FUTURE },
];

let container;
let client;
let inbox;

const remainingIds = async () => {
  const docs = await inbox.find({}, { projection: { _id: 1 } }).toArray();

  return docs.map((doc) => doc._id).sort();
};

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(27017)
    .withCommand([
      "mongod",
      "--bind_ip_all",
      "--setParameter",
      `ttlMonitorSleepSecs=${TTL_MONITOR_SECONDS}`,
    ])
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .start();

  const uri = `mongodb://${container.getHost()}:${container.getMappedPort(27017)}`;

  client = await MongoClient.connect(uri);

  const db = client.db("fg-cw-backend-ttl");
  inbox = db.collection("inbox");

  // Seeded after the migration, so the null and missing rows stay unscheduled.
  await up(db);
  await inbox.insertMany(FIXTURES);
}, 180_000);

afterAll(async () => {
  await client?.close(true);
  await container?.stop();
});

describe("expireAt_ttl", () => {
  it("deletes completed and purged rows whose date has passed", async () => {
    await vi.waitFor(
      async () => {
        const ids = await remainingIds();

        for (const id of DELETED) {
          expect(ids).not.toContain(id);
        }
      },
      { timeout: 30_000, interval: 500 },
    );
  }, 60_000);

  it("deletes nothing else", async () => {
    expect(await remainingIds()).toEqual([...SURVIVORS].sort());
  });
});
