import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../common/config.js";
import { db } from "../../common/mongo-client.js";
import { paginate } from "../../common/paginate.js";
import { Outbox, OutboxStatus } from "../models/outbox.js";
import {
  breakdown,
  claimEvents,
  findDetailById,
  findNextMessage,
  findPage,
  insertMany,
  redriveById,
  update,
  updateDeadEvents,
  updateExpiredEvents,
  updateFailedEvents,
  updateResubmittedEvents,
} from "./outbox.repository.js";

vi.mock("../../common/mongo-client.js");
// Real codecs, so the tampered-cursor tests assert real behaviour.
vi.mock("../../common/paginate.js", async (importOriginal) => ({
  ...(await importOriginal()),
  paginate: vi.fn(),
}));

const AUDIT_TOPIC_ARN = config.get("aws.sns.auditTopicArn");
const AUDIT_CLAUSE = { $not: /(^|:)cw__sns__audit_topic_arn$/ };

describe("outbox.repository", () => {
  describe("findNextMessage", () => {
    it("should find next message excluding locked segregationRefs", async () => {
      const lockIds = ["ref-a", "ref-b"];
      const mockDoc = { _id: "1", segregationRef: "ref-c" };
      const findOne = vi.fn().mockResolvedValue(mockDoc);

      db.collection.mockReturnValue({ findOne });

      const result = await findNextMessage(lockIds);

      expect(findOne).toHaveBeenCalledWith(
        {
          status: { $eq: OutboxStatus.PUBLISHED },
          claimedBy: { $eq: null },
          completionAttempts: {
            $lt: parseInt(config.get("outbox.outboxMaxRetries")),
          },
          segregationRef: { $nin: lockIds },
        },
        { sort: { publicationDate: 1 } },
      );
      expect(result).toBe(mockDoc);
    });
  });

  describe("insertMany", () => {
    it("should insert events", async () => {
      const mockInsertMany = vi.fn().mockResolvedValueOnce({
        modifiedCount: 1,
      });
      db.collection.mockReturnValue({
        insertMany: mockInsertMany,
      });

      const events = [
        new Outbox({
          target: "arn:some:arn:value",
          event: {
            clientRef: "1234-7778",
          },
          segregationRef: "test-segregation-ref-1",
        }),
        new Outbox({
          target: "arn:some:other:value",
          event: {
            clientRef: "0987-1234",
          },
          segregationRef: "test-segregation-ref-2",
        }),
      ];

      const mockSession = vi.fn();

      await insertMany(events, mockSession);

      expect(mockInsertMany).toHaveBeenCalledWith(events, {
        session: mockSession,
      });
    });
  });

  describe("claimEvents", () => {
    it("should fetch any pending events", async () => {
      const claimedBy = randomUUID();
      const mockDocument = {
        _id: "1234",
        publicationDate: new Date(),
        target: "arn:an:arn:value",
        event: {
          clientRef: "1234-5668",
        },
        completionAttempts: 1,
        status: OutboxStatus.PUBLISHED,
        segregationRef: "test-segregation-ref",
      };
      const findOneAndUpdateMock = vi.fn();
      findOneAndUpdateMock
        .mockResolvedValueOnce(mockDocument)
        .mockResolvedValueOnce(null);

      db.collection.mockReturnValue({ findOneAndUpdate: findOneAndUpdateMock });

      const results = await claimEvents(claimedBy);
      expect(results[0]).toBeInstanceOf(Outbox);
      expect(results).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("calls updateOne", async () => {
      const mockUpdate = vi.fn();
      db.collection.mockReturnValue({
        updateOne: mockUpdate,
      });
      const claimedBy = randomUUID();
      const _id = randomUUID();
      const event = {};

      const outboxEvent = new Outbox({
        _id,
        event,
        publicationDate: new Date(),
        target: "arn:foo:bar",
        completionAttempts: 1,
        status: OutboxStatus.PROCESSING,
        segregationRef: "test-segregation-ref",
      });

      await update(outboxEvent, claimedBy);
      expect(mockUpdate).toHaveBeenCalledWith(
        {
          _id,
          claimedBy,
        },
        {
          $set: {
            claimExpiresAt: null,
            claimedAt: null,
            claimedBy: null,
            completionAttempts: 1,
            completionDate: undefined,
            event: {},
            lastResubmissionDate: undefined,
            lastError: null,
            attemptHistory: [],
            lastRedrive: null,
            publicationDate: expect.any(Date),
            status: "PROCESSING",
            target: "arn:foo:bar",
            segregationRef: expect.any(String),
          },
        },
      );
    });
  });

  describe("updateExpiredEvents", () => {
    it("should call updateMany", async () => {
      const updateMany = vi.fn().mockResolvedValue({});
      db.collection.mockReturnValue({
        updateMany,
      });

      await updateExpiredEvents();

      expect(updateMany).toHaveBeenCalledWith(
        {
          claimExpiresAt: {
            $lt: expect.any(Date),
          },
          status: { $nin: [OutboxStatus.DEAD_LETTER, OutboxStatus.COMPLETED] },
        },
        {
          $set: {
            status: OutboxStatus.FAILED,
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
  });

  describe("updateFailedEvents", () => {
    it("should call updateMany", async () => {
      const updateMany = vi.fn().mockResolvedValue({});
      db.collection.mockReturnValue({
        updateMany,
      });

      await updateFailedEvents();

      expect(updateMany).toHaveBeenCalledWith(
        {
          status: OutboxStatus.FAILED,
        },
        {
          $set: {
            status: OutboxStatus.RESUBMITTED,
            claimedAt: null,
            claimedBy: null,
            claimExpiresAt: null,
          },
        },
      );
    });
  });

  describe("updateResubmittedEvents", () => {
    it("should call updateMany", async () => {
      const updateMany = vi.fn().mockResolvedValue({});
      db.collection.mockReturnValue({
        updateMany,
      });
      await updateResubmittedEvents();

      expect(updateMany).toHaveBeenCalledWith(
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
    });
  });

  describe("updateDeadEvents", () => {
    it("should call updateMany", async () => {
      const MAX_RETRIES = parseInt(config.get("outbox.outboxMaxRetries"));
      const updateMany = vi.fn().mockResolvedValue({});
      db.collection.mockReturnValue({
        updateMany,
      });
      const mockDate = new Date(20245, 10, 9);
      vi.setSystemTime(mockDate);
      await updateDeadEvents();
      expect(updateMany).toBeCalledWith(
        {
          completionAttempts: { $gte: MAX_RETRIES },
          status: {
            $nin: [OutboxStatus.DEAD_LETTER, OutboxStatus.COMPLETED],
          },
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
    });
  });
});

// Only the outbox's own wiring: the shared queries are tested once, in
// actuator-box.repository.test.js.
describe("outbox.repository actuator wiring", () => {
  const ID = "665f1c2e9a1b2c3d4e5f6a7c";
  const FROM = "2026-06-16T00:00:00.000Z";
  const TARGET =
    "arn:aws:sns:eu-west-2:000000000000:cw__sns__case_status_updated";

  const pageOptions = async (args = {}) => {
    paginate.mockResolvedValue({ data: [], pagination: {} });

    await findPage({ pageSize: 20, ...args });

    return paginate.mock.calls.at(-1)[1];
  };

  const aDoc = (overrides = {}) => ({
    _id: new ObjectId(ID),
    event: {
      id: "9b4d2f10",
      type: "cloud.defra.prd.fg-cw-backend.case.status.updated",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      data: { clientRef: "REF-1" },
    },
    target: TARGET,
    segregationRef: "GLD-9B2",
    status: OutboxStatus.COMPLETED,
    completionAttempts: 1,
    publicationDate: new Date("2026-06-16T10:00:01.000Z"),
    lastResubmissionDate: null,
    completionDate: new Date("2026-06-16T10:00:02.000Z"),
    lastError: null,
    ...overrides,
  });

  // What `common/write-audit-event.js` writes: no CloudEvent id or type.
  const anAuditDoc = () =>
    aDoc({
      event: { audit: { entities: [{ entity: "CASE" }], details: {} } },
      target: AUDIT_TOPIC_ARN,
    });

  beforeEach(() => {
    vi.mocked(paginate).mockReset();
  });

  it("maps an outbox document to exactly the list row", async () => {
    const { mapDocument } = await pageOptions();

    expect(mapDocument(aDoc())).toEqual({
      _id: ID,
      eventId: "9b4d2f10",
      type: "cloud.defra.prd.fg-cw-backend.case.status.updated",
      status: OutboxStatus.COMPLETED,
      publicationDate: "2026-06-16T10:00:01.000Z",
      completedAt: "2026-06-16T10:00:02.000Z",
    });
  });

  it("labels an audit record audit, with no id and nothing of its payload", async () => {
    const { mapDocument } = await pageOptions();
    const row = mapDocument(anAuditDoc());

    expect(row).toMatchObject({ eventId: null, type: "audit" });
    expect(JSON.stringify(row)).not.toMatch(/CASE|details/);
  });

  it("labels a type-less row with no event or target unknown", async () => {
    const { mapDocument } = await pageOptions();

    expect(
      mapDocument(aDoc({ event: undefined, target: undefined })),
    ).toMatchObject({ eventId: null, type: "unknown" });
  });

  it("projects the fields the row reads", async () => {
    const { project } = await pageOptions();

    expect(project).toEqual({
      _id: 1,
      "event.id": 1,
      "event.type": 1,
      target: 1,
      status: 1,
      publicationDate: 1,
      completionDate: 1,
    });
  });

  it("searches event.id and event.traceparent", async () => {
    const { filter } = await pageOptions({ q: "evt-1" });

    expect(filter.$or).toContainEqual({ "event.id": "evt-1" });
    expect(filter.$or).toContainEqual({ "event.traceparent": "evt-1" });
  });

  it("excludes on the target the row is labelled audit from", async () => {
    const { filter, mapDocument } = await pageOptions({ audit: "exclude" });
    const doc = anAuditDoc();

    expect(filter).toEqual({ target: AUDIT_CLAUSE });
    expect(mapDocument(doc).type).toBe("audit");
    expect(doc.target).toMatch(filter.target.$not);
  });

  it("reads and bounds publicationDate as a BSON Date", async () => {
    const { codecs, filter } = await pageOptions({ from: FROM });

    expect(codecs.publicationDate.decode(FROM)).toEqual(new Date(FROM));
    expect(filter).toEqual({ publicationDate: { $gte: new Date(FROM) } });
  });

  it("stamps the outbox retry cap on the detail", async () => {
    db.collection.mockReturnValue({
      findOne: vi.fn().mockResolvedValue(aDoc()),
    });

    expect((await findDetailById(ID)).maxAttempts).toBe(
      parseInt(config.get("outbox.outboxMaxRetries")),
    );
  });

  it("redrives into the outbox's RESUBMITTED status", async () => {
    const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });
    db.collection.mockReturnValue({ updateOne });

    expect(await redriveById(ID)).toBe(true);
    expect(updateOne.mock.calls[0][1].$set.status).toBe(
      OutboxStatus.RESUBMITTED,
    );
  });

  it("groups the breakdown on the outbox type field and audit target", async () => {
    const aggregate = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    });
    db.collection.mockReturnValue({ aggregate });

    await breakdown({});

    expect(aggregate.mock.calls[0][0][1].$group._id).toEqual({
      error: { $ifNull: ["$lastError.message", null] },
      type: { $ifNull: ["$event.type", null] },
      audit: {
        $eq: [
          { $arrayElemAt: [{ $split: ["$target", ":"] }, -1] },
          "cw__sns__audit_topic_arn",
        ],
      },
    });
  });
});
