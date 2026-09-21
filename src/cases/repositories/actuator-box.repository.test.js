import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../common/mongo-client.js";
import { dateCodec, paginate, stringCodec } from "../../common/paginate.js";
import { actuatorBoxQueries } from "./actuator-box.repository.js";

vi.mock("../../common/mongo-client.js");
vi.mock("../../common/paginate.js", async (importOriginal) => ({
  ...(await importOriginal()),
  paginate: vi.fn(),
}));

const ID = "665f1c2e9a1b2c3d4e5f6a7b";
// The configured default: every actuator read is bounded by it.
const MAX_TIME_MS = 3000;
const FROM = "2026-06-16T00:00:00.000Z";

const rowFields = {
  eventId: { reads: ["event.id"], map: (doc) => doc.event.id },
  target: { reads: ["target", "event.id"], map: (doc) => doc.target },
};

const queriesFor = (overrides = {}) =>
  actuatorBoxQueries({
    collection: "some-box",
    box: "outbox",
    maxRetries: 7,
    resubmittedStatus: "AGAIN",
    publicationDateStorage: "date",
    eventIdField: "event.id",
    traceparentField: "event.traceparent",
    rowFields,
    ...overrides,
  });

const mockAggregate = (rows) => {
  const aggregate = vi
    .fn()
    .mockReturnValue({ toArray: vi.fn().mockResolvedValue(rows) });
  db.collection.mockReturnValue({ aggregate });

  return aggregate;
};

describe("actuatorBoxQueries findPage", () => {
  const pageOptions = async (overrides, args = {}) => {
    db.collection.mockReturnValue({});
    await queriesFor(overrides).findPage({ pageSize: 5, ...args });

    return paginate.mock.calls.at(-1)[1];
  };

  beforeEach(() => {
    vi.mocked(paginate).mockReset().mockResolvedValue({ data: [] });
  });

  it("pages the box's collection forward, newest first, without a total", async () => {
    const opts = await pageOptions({}, { cursor: "abc", pageSize: 7 });

    expect(db.collection).toHaveBeenCalledWith("some-box");
    expect(opts.sort).toEqual({ publicationDate: -1, _id: -1 });
    expect(opts.cursor).toBe("abc");
    expect(opts.pageSize).toBe(7);
    expect(opts.withTotal).toBe(false);
    expect(opts.maxTimeMS).toBe(MAX_TIME_MS);
  });

  it("keys the cursor on publicationDate and an ObjectId _id", async () => {
    const opts = await pageOptions();
    const objectId = new ObjectId(ID);

    expect(Object.keys(opts.codecs)).toEqual(["publicationDate", "_id"]);
    expect(opts.codecs._id.encode(objectId)).toBe(ID);
    expect(opts.codecs._id.decode(ID)).toEqual(objectId);
  });

  it.each([
    ["string", stringCodec, FROM],
    ["date", dateCodec, new Date(FROM)],
  ])(
    "reads and bounds publicationDate stored as a %s",
    async (storage, codec, bound) => {
      const opts = await pageOptions(
        { publicationDateStorage: storage },
        { from: FROM },
      );

      expect(opts.codecs.publicationDate).toBe(codec);
      expect(opts.filter).toEqual({ publicationDate: { $gte: bound } });
    },
  );

  it("projects every field the row reads, once", async () => {
    const opts = await pageOptions();

    expect(opts.project).toEqual({
      _id: 1,
      "event.id": 1,
      target: 1,
      status: 1,
      publicationDate: 1,
      completionDate: 1,
    });
  });

  it("maps the box's row fields and the shared ones", async () => {
    const { mapDocument } = await pageOptions();

    const row = mapDocument({
      _id: new ObjectId(ID),
      event: { id: "evt-1", data: { secret: true } },
      target: "arn",
      status: "FAILED",
      completionAttempts: 2,
      publicationDate: new Date(FROM),
      completionDate: "2026-06-16T10:00:00.000Z",
      lastError: { name: "Error", message: "boom", at: null },
      claimedBy: "token",
    });

    expect(row).toEqual({
      _id: ID,
      eventId: "evt-1",
      target: "arn",
      status: "FAILED",
      publicationDate: FROM,
      completedAt: "2026-06-16T10:00:00.000Z",
    });
  });

  it("answers null rather than undefined for absent shared fields", async () => {
    const { mapDocument } = await pageOptions();

    expect(
      mapDocument({ _id: new ObjectId(ID), event: {}, status: "PUBLISHED" }),
    ).toMatchObject({ publicationDate: null, completedAt: null });
  });

  it.each(["_id", "status", "publicationDate", "completedAt"])(
    "refuses a box row field named like the shared %s",
    (name) => {
      expect(() =>
        queriesFor({
          rowFields: { ...rowFields, [name]: { reads: [], map: () => null } },
        }),
      ).toThrow(`Row field "${name}" is already a shared row field`);
    },
  );

  it("returns the paginate result unchanged", async () => {
    const page = { data: [], pagination: { hasNextPage: false } };
    paginate.mockResolvedValue(page);
    db.collection.mockReturnValue({});

    await expect(queriesFor().findPage({ pageSize: 5 })).resolves.toBe(page);
  });
});

describe("actuatorBoxQueries detail and status", () => {
  it("projects the claim fields away from the detail, with the box's retry cap", async () => {
    const findOne = vi
      .fn()
      .mockResolvedValue({ _id: new ObjectId(ID), status: "DEAD_LETTER" });
    db.collection.mockReturnValue({ findOne });

    const detail = await queriesFor().findDetailById(ID);

    expect(findOne).toHaveBeenCalledWith(
      { _id: new ObjectId(ID) },
      {
        projection: { claimedBy: 0, claimedAt: 0, claimExpiresAt: 0 },
        maxTimeMS: MAX_TIME_MS,
      },
    );
    expect(detail.maxAttempts).toBe(7);
  });

  it("returns a null detail when there is no such row", async () => {
    db.collection.mockReturnValue({ findOne: vi.fn().mockResolvedValue(null) });

    expect(await queriesFor().findDetailById(ID)).toBeNull();
  });

  it("reads only the status for the 404-vs-409 decision", async () => {
    const findOne = vi.fn().mockResolvedValue({ status: "COMPLETED" });
    db.collection.mockReturnValue({ findOne });

    expect(await queriesFor().findStatusById(ID, "session")).toBe("COMPLETED");
    expect(findOne).toHaveBeenCalledWith(
      { _id: new ObjectId(ID) },
      { projection: { status: 1 }, session: "session", maxTimeMS: MAX_TIME_MS },
    );
  });

  it("returns a null status for an unknown id", async () => {
    db.collection.mockReturnValue({ findOne: vi.fn().mockResolvedValue(null) });

    expect(await queriesFor().findStatusById(ID)).toBeNull();
  });
});

describe("actuatorBoxQueries redriveById", () => {
  it("redrives with one conditional update filtered on the redrivable statuses", async () => {
    const _id = new ObjectId(ID);
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    expect(await queriesFor().redriveById(ID, { by: "ada" })).toBe(true);
    expect(updateOne).toHaveBeenCalledWith(
      { _id, status: { $in: ["DEAD_LETTER", "PURGED"] } },
      {
        $set: {
          status: "AGAIN",
          completionAttempts: 0,
          attemptHistory: [],
          lastRedrive: { at: expect.any(String), by: "ada" },
          expireAt: null,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
        },
      },
      { session: undefined },
    );
  });

  it("answers false when the conditional update matched nothing", async () => {
    db.collection.mockReturnValue({
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    });

    expect(await queriesFor().redriveById(ID)).toBe(false);
  });

  it("accepts a PURGED row as well as a DEAD_LETTER one", async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    await queriesFor().redriveById(ID);

    const [filter] = updateOne.mock.calls.at(-1);

    expect(filter.status.$in).toContain("PURGED");
    expect(filter.status.$in).toContain("DEAD_LETTER");
  });

  it("does not touch lastPurge, so a redriven row still knows it was purged", async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    await queriesFor().redriveById(ID);

    const [, update] = updateOne.mock.calls.at(-1);

    expect(update.$set).not.toHaveProperty("lastPurge");
    expect(JSON.stringify(update)).not.toContain("lastPurge");
  });
});

describe("actuatorBoxQueries purgeById", () => {
  const purgeCall = async (command) => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    await queriesFor().purgeById(ID, command);

    return updateOne.mock.calls.at(-1);
  };

  it("purges with one conditional update fenced on DEAD_LETTER alone", async () => {
    const [filter] = await purgeCall({
      by: "ada",
      reasonCode: "BROKEN_PAYLOAD",
      note: null,
    });

    expect(filter).toEqual({ _id: new ObjectId(ID), status: "DEAD_LETTER" });
  });

  it("leaves the row PURGED with the reason, the operator and a deletion date", async () => {
    const [, update] = await purgeCall({
      by: "ada",
      reasonCode: "SENT_IN_ERROR",
      note: "duplicate",
    });

    expect(update.$set.status).toBe("PURGED");
    expect(update.$set.lastPurge).toEqual({
      at: expect.any(String),
      by: "ada",
      reasonCode: "SENT_IN_ERROR",
      note: "duplicate",
    });
    expect(update.$set.expireAt).toBeInstanceOf(Date);
  });

  // The update joins the caller's transaction, so it commits with the audit
  // event the use case writes beside it.
  it("passes the caller's session to the update", async () => {
    const session = { id: "the-transaction" };

    const [, , options] = await purgeCall({
      reasonCode: "OTHER",
      note: "why",
      session,
    });

    expect(options).toEqual({ session });
  });

  it("answers false when the conditional update matched nothing", async () => {
    db.collection.mockReturnValue({
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    });

    expect(
      await queriesFor().purgeById(ID, { reasonCode: "BROKEN_PAYLOAD" }),
    ).toBe(false);
  });
});

describe("actuatorBoxQueries countFacets", () => {
  it("counts the whole box when nothing is filtered", async () => {
    const aggregate = mockAggregate([]);

    await queriesFor().countFacets();

    expect(aggregate).toHaveBeenCalledWith(
      [{ $match: {} }, { $group: { _id: "$status", count: { $sum: 1 } } }],
      { maxTimeMS: MAX_TIME_MS },
    );
  });

  it("counts the rows the $group emits into their statuses, zero-filling the rest", async () => {
    mockAggregate([{ _id: "FAILED", count: 3 }]);

    expect(await queriesFor().countFacets()).toEqual({
      counts: {
        PUBLISHED: 0,
        PROCESSING: 0,
        FAILED: 3,
        RESUBMITTED: 0,
        COMPLETED: 0,
        DEAD_LETTER: 0,
        PURGED: 0,
      },
    });
  });
});

describe("actuatorBoxQueries breakdown", () => {
  it("scopes itself to DEAD_LETTER, whatever the caller asked for", async () => {
    const aggregate = mockAggregate([]);

    await queriesFor().breakdown({ status: "FAILED" });

    expect(JSON.stringify(aggregate.mock.calls[0][0][0].$match)).toContain(
      "DEAD_LETTER",
    );
  });

  it("never widens to PURGED, even though a purged row is redrivable", async () => {
    const aggregate = mockAggregate([]);

    await queriesFor().breakdown({ status: "PURGED" });

    expect(JSON.stringify(aggregate.mock.calls[0][0][0].$match)).not.toContain(
      "PURGED",
    );
  });

  it("takes first-seen and last-seen off publicationDate", async () => {
    const aggregate = mockAggregate([]);

    await queriesFor().breakdown();

    const [[, group], options] = aggregate.mock.calls[0];

    expect(options).toEqual({ maxTimeMS: MAX_TIME_MS });
    expect(group.$group.firstAt).toEqual({ $min: "$publicationDate" });
    expect(group.$group.lastAt).toEqual({ $max: "$publicationDate" });
  });

  it("maps the aggregation rows into groups, keeping a null-error group", async () => {
    mockAggregate([
      {
        _id: { error: null, type: "t" },
        count: 3,
        firstAt: "2026-06-16T10:00:00.000Z",
        lastAt: "2026-06-16T11:00:00.000Z",
      },
    ]);

    expect(await queriesFor().breakdown()).toEqual([
      {
        error: null,
        type: "t",
        audit: false,
        count: 3,
        firstAt: "2026-06-16T10:00:00.000Z",
        lastAt: "2026-06-16T11:00:00.000Z",
      },
    ]);
  });
});
