import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editPayloadById,
  findEditableById,
  findStatusById,
} from "../../cases/repositories/outbox.repository.js";
import { withTransaction } from "../../common/with-transaction.js";
import { writeAuditEvent } from "../../common/write-audit-event.js";
import { editOutboxEventPayloadUseCase } from "./edit-outbox-event-payload.use-case.js";

vi.mock("../../common/mongo-client.js");
vi.mock("../../common/with-transaction.js");
vi.mock("../../common/write-audit-event.js");
vi.mock("../../cases/repositories/outbox.repository.js");

const ID = "665f1c2e9a1b2c3d4e5f6a7b";
const SESSION = { id: "the-transaction" };
const STORED = { id: "evt-2", messageGroupId: "g-1", data: { a: 1 } };

const aCommand = (overrides = {}) => ({
  id: ID,
  by: "ada",
  caller: "fg-gas-backend",
  payload: { ...STORED, messageGroupId: "g-2" },
  note: "moved to the right group",
  revision: 1,
  ...overrides,
});

const refusedWith = async (command) =>
  editOutboxEventPayloadUseCase(command).catch((error) => error.output);

beforeEach(() => {
  withTransaction.mockImplementation(async (run) => run(SESSION));
  findEditableById.mockResolvedValue({ _id: ID, event: STORED });
  editPayloadById.mockResolvedValue(true);
});

describe("editOutboxEventPayloadUseCase", () => {
  it("edits the outbox row, envelope fields included", async () => {
    expect(await editOutboxEventPayloadUseCase(aCommand())).toMatchObject({
      payloadRevision: 2,
      changedPaths: ["/messageGroupId"],
    });
    expect(editPayloadById).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({
        revision: 1,
        original: STORED,
        session: SESSION,
      }),
    );
  });

  it("404s when there is no such row", async () => {
    findEditableById.mockResolvedValue(null);

    expect((await refusedWith(aCommand())).statusCode).toBe(404);
  });

  it("409s with the status when the row is not redrivable", async () => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("COMPLETED");

    const output = await refusedWith(aCommand());

    expect(output.statusCode).toBe(409);
    expect(output.payload.status).toBe("COMPLETED");
  });

  it("412s when the row was edited since the revision", async () => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("PURGED");

    expect((await refusedWith(aCommand())).statusCode).toBe(412);
  });

  it("audits the edit as an outbox one, in the transaction", async () => {
    await editOutboxEventPayloadUseCase(aCommand());

    const [payload, session] = writeAuditEvent.mock.calls[0];

    expect(session).toBe(SESSION);
    expect(payload.entities[0].action).toBe("EDIT_EVENT_PAYLOAD");
    expect(payload.details.event).toMatchObject({
      box: "outbox",
      revision: 1,
      changedPaths: ["/messageGroupId"],
    });
    expect(JSON.stringify(payload)).not.toContain("moved to the right group");
  });
});
