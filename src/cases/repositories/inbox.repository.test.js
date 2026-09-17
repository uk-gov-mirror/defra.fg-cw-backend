import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../common/config.js";
import { db } from "../../common/mongo-client.js";
import { paginate } from "../../common/paginate.js";
import { Inbox, InboxStatus } from "../models/inbox.js";
import {
  breakdown,
  claimEvents,
  findByMessageId,
  findDetailById,
  findNextMessage,
  findPage,
  insertMany,
  insertOne,
  processExpiredEvents,
  redriveById,
  update,
  updateDeadEvents,
  updateFailedEvents,
  updateResubmittedEvents,
} from "./inbox.repository.js";

vi.mock("../../common/mongo-client.js");
// Real codecs, so the tampered-cursor tests assert real behaviour.
vi.mock("../../common/paginate.js", async (importOriginal) => ({
  ...(await importOriginal()),
  paginate: vi.fn(),
}));

const AUDIT_TOPIC_ARN = config.get("aws.sns.auditTopicArn");

const createMockInbox = (id, time) => {
  return Inbox.createMock({
    _id: id,
    event: {
      time,
    },
  });
};

describe("inbox.repository", () => {
  it("should find next message excluding locked segregationRefs", async () => {
    const lockIds = ["ref-1", "ref-2"];
    const mockDoc = { _id: "1" };
    const findOne = vi.fn().mockResolvedValue(mockDoc);

    db.collection.mockReturnValue({ findOne });

    const result = await findNextMessage(lockIds);

    expect(findOne).toHaveBeenCalledWith(
      {
        status: { $eq: InboxStatus.PUBLISHED },
        claimedBy: { $eq: null },
        completionAttempts: {
          $lt: parseInt(config.get("inbox.inboxMaxRetries")),
        },
        segregationRef: { $nin: lockIds },
      },
      { sort: { eventTime: 1 } },
    );
    expect(result).toBe(mockDoc);
  });

  it("should claim events", async () => {
    const claimedBy = randomUUID();
    const mockDocuments = [
      createMockInbox("1", new Date(Date.now() - 1000).toISOString()),
      createMockInbox("3", new Date(Date.now() - 2000).toISOString()),
    ];

    const findOneAndUpdate = vi.fn();
    findOneAndUpdate
      .mockResolvedValueOnce(mockDocuments[0])
      .mockResolvedValueOnce(mockDocuments[1]);

    db.collection.mockReturnValue({
      findOneAndUpdate,
    });

    const results = await claimEvents(claimedBy);
    expect(results).toHaveLength(2);
    expect(results[0]).toBeInstanceOf(Inbox);
    expect(results[1]).toBeInstanceOf(Inbox);
    expect(results[0]._id).toBe("1");
    expect(results[1]._id).toBe("3");
  });

  it("claims in the sender's eventTime order, not publicationDate", async () => {
    const findOneAndUpdate = vi.fn().mockResolvedValue(null);
    db.collection.mockReturnValue({ findOneAndUpdate });

    await claimEvents(randomUUID(), "ref-1", 1);

    expect(findOneAndUpdate.mock.calls[0][2]).toEqual({
      sort: { eventTime: 1 },
      returnDocument: "after",
    });
  });

  it("should insert many", async () => {
    const insertMany = vi.fn().mockResolvedValueOnce({ modifiedCount: 1 });
    db.collection.mockReturnValue({ insertMany });

    const events = [Inbox.createMock(), Inbox.createMock()];

    const mockSession = vi.fn();
    await insertMany(events, mockSession);
    expect(insertMany).toHaveBeenCalledWith(events, mockSession);
  });

  it("should process expired events", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    db.collection.mockReturnValue({
      updateMany,
    });

    await processExpiredEvents();

    expect(updateMany).toHaveBeenCalledWith(
      {
        claimExpiresAt: {
          $lt: expect.any(Date),
        },
        status: { $nin: [InboxStatus.DEAD_LETTER, InboxStatus.COMPLETED] },
      },
      {
        $set: {
          status: InboxStatus.FAILED,
          lastError: {
            name: "ClaimExpired",
            message: "claim expired before completion",
            at: expect.any(String),
          },
          claimedAt: null,
          claimedBy: null,
          claimExpiresAt: null,
        },
        $inc: { completionAttempts: 1 },
        $push: {
          attemptHistory: {
            $each: [
              {
                at: expect.any(String),
                name: "ClaimExpired",
                message: "claim expired before completion",
                stack: null,
              },
            ],
            $slice: -10,
          },
        },
      },
    );
  });

  it("should update dead events", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    db.collection.mockReturnValue({ updateMany });

    await updateDeadEvents();

    expect(updateMany).toHaveBeenCalledWith(
      {
        completionAttempts: {
          $gte: parseInt(config.get("inbox.inboxMaxRetries")),
        },
        status: { $nin: [InboxStatus.DEAD_LETTER, InboxStatus.COMPLETED] },
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
  });

  it("should update resubmitted events", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    db.collection.mockReturnValue({ updateMany });

    await updateResubmittedEvents();

    expect(updateMany).toHaveBeenCalledWith(
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
  });

  it("should update failed events", async () => {
    const updateMany = vi.fn().mockResolvedValue({});
    db.collection.mockReturnValue({ updateMany });

    await updateFailedEvents();

    expect(updateMany).toHaveBeenCalledWith(
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
  });

  it("should insertMany", async () => {
    const insertManySpy = vi.fn();
    db.collection.mockReturnValue({ insertMany: insertManySpy });
    const session = {};

    const events = [
      Inbox.createMock({
        event: {
          some_data_bar: "foo",
        },
      }),
    ];

    await insertMany(events, session);

    expect(insertManySpy).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          event: {
            some_data_bar: "foo",
          },
        }),
      ],
      { session },
    );
  });

  it("should findByMessageId", async () => {
    const id = randomUUID();
    const mockDoc = { _id: id };
    const findOneMock = vi.fn().mockResolvedValue(mockDoc);
    db.collection.mockReturnValue({ findOne: findOneMock });
    const doc = await findByMessageId(id);
    expect(findOneMock).toHaveBeenCalledWith({ messageId: id });
    expect(mockDoc).toEqual(doc);
  });

  it("should insertOne", async () => {
    const id = randomUUID();
    const insertOneMock = vi.fn();
    db.collection.mockReturnValue({ insertOne: insertOneMock });
    const session = {};
    const doc = Inbox.createMock({
      _id: id,
    });
    await insertOne(doc, session);
    expect(insertOneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: id,
      }),
      { session },
    );
  });

  it("should update a document", async () => {
    const id = randomUUID();
    const inbox = Inbox.createMock({ _id: id });
    vi.spyOn(inbox, "toDocument").mockReturnValue({
      _id: id,
      someOtherValue: "foo",
    });
    const updateOneMock = vi.fn();
    db.collection.mockReturnValue({ updateOne: updateOneMock });

    await update(inbox);

    expect(inbox.toDocument).toHaveBeenCalled();
    expect(updateOneMock).toHaveBeenCalledWith(
      { _id: id },
      {
        $set: expect.objectContaining({ someOtherValue: "foo" }),
      },
    );
  });
});

// Only the inbox's own wiring: the shared queries are tested once, in
// actuator-box.repository.test.js.
describe("inbox.repository actuator wiring", () => {
  const ID = "665f1c2e9a1b2c3d4e5f6a7b";
  const FROM = "2026-06-16T00:00:00.000Z";

  const pageOptions = async (args = {}) => {
    paginate.mockResolvedValue({ data: [], pagination: {} });

    await findPage({ pageSize: 20, ...args });

    return paginate.mock.calls.at(-1)[1];
  };

  const aDoc = (overrides = {}) => ({
    _id: new ObjectId(ID),
    messageId: "msg-1",
    type: "cloud.defra.prd.fg-gas-backend.case.create.new",
    source: "GAS",
    segregationRef: "GLD-9B2",
    status: InboxStatus.DEAD_LETTER,
    completionAttempts: 5,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    eventTime: "2026-06-16T09:59:00.000Z",
    publicationDate: "2026-06-16T10:00:00.000Z",
    lastResubmissionDate: "2026-06-16T10:05:00.000Z",
    completionDate: null,
    lastError: { name: "TypeError", message: "boom", at: null },
    event: { id: "evt-1" },
    ...overrides,
  });

  beforeEach(() => {
    vi.mocked(paginate).mockReset();
  });

  it("maps an inbox document to exactly the list row", async () => {
    const { mapDocument } = await pageOptions();

    expect(mapDocument(aDoc())).toEqual({
      _id: ID,
      eventId: "msg-1",
      type: "cloud.defra.prd.fg-gas-backend.case.create.new",
      status: InboxStatus.DEAD_LETTER,
      publicationDate: "2026-06-16T10:00:00.000Z",
      completedAt: null,
    });
  });

  it("labels a type-less inbox row unknown and never takes eventTime", async () => {
    const { mapDocument } = await pageOptions();

    expect(
      mapDocument(
        aDoc({ messageId: undefined, type: undefined, publicationDate: null }),
      ),
    ).toMatchObject({ eventId: null, type: "unknown", publicationDate: null });
  });

  it("projects the fields the row reads", async () => {
    const { project } = await pageOptions();

    expect(project).toEqual({
      _id: 1,
      messageId: 1,
      type: 1,
      status: 1,
      publicationDate: 1,
      completionDate: 1,
    });
  });

  it("searches messageId and traceparent", async () => {
    const { filter } = await pageOptions({ q: "msg-1" });

    expect(filter.$or).toContainEqual({ messageId: "msg-1" });
    expect(filter.$or).toContainEqual({ traceparent: "msg-1" });
  });

  it("removes nothing from the inbox even when audit records are excluded", async () => {
    const { filter } = await pageOptions({ audit: "exclude" });

    expect(filter).toEqual({});
    expect(JSON.stringify(filter)).not.toContain(AUDIT_TOPIC_ARN);
  });

  it("reads and bounds publicationDate as an ISO string", async () => {
    const { codecs, filter } = await pageOptions({ from: FROM });

    expect(codecs.publicationDate.decode(FROM)).toBe(FROM);
    expect(filter).toEqual({ publicationDate: { $gte: FROM } });
  });

  it("stamps the inbox retry cap on the detail", async () => {
    db.collection.mockReturnValue({
      findOne: vi.fn().mockResolvedValue(aDoc()),
    });

    expect((await findDetailById(ID)).maxAttempts).toBe(
      parseInt(config.get("inbox.inboxMaxRetries")),
    );
  });

  it("redrives into the inbox's RESUBMITTED status", async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    expect(await redriveById(ID)).toBe(true);
    expect(updateOne.mock.calls[0][1].$set.status).toBe(
      InboxStatus.RESUBMITTED,
    );
  });

  it("groups the breakdown on the inbox type field, never as audit", async () => {
    const aggregate = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    });
    db.collection.mockReturnValue({ aggregate });

    await breakdown({});

    expect(aggregate.mock.calls[0][0][1].$group._id).toEqual({
      error: { $ifNull: ["$lastError.message", null] },
      type: { $ifNull: ["$type", null] },
      audit: { $literal: false },
    });
  });
});
