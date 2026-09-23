import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editPayloadById,
  findEditableById,
  findStatusById,
} from "../../cases/repositories/inbox.repository.js";
import { logger } from "../../common/logger.js";
import { withTransaction } from "../../common/with-transaction.js";
import { writeAuditEvent } from "../../common/write-audit-event.js";
import { payloadHash } from "../../events/payload-changes.js";
import { editInboxEventPayloadUseCase } from "./edit-inbox-event-payload.use-case.js";

vi.mock("../../common/mongo-client.js");
vi.mock("../../common/with-transaction.js");
vi.mock("../../common/write-audit-event.js");
vi.mock("../../common/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../cases/repositories/inbox.repository.js");

const ID = "665f1c2e9a1b2c3d4e5f6a7b";

// The session `withTransaction` hands a real caller. Everything that has to
// join the transaction is asserted against this exact object.
const SESSION = { id: "the-transaction" };

const STORED = { id: "evt-1", data: { name: "Ada Lovelace", amount: "12" } };
const EDITED = { id: "evt-1", data: { name: "Ada Lovelace", amount: 12 } };
const NOTE = "amount sent as a string by Grace Hopper's form";

const aCommand = (overrides = {}) => ({
  id: ID,
  by: "ada",
  caller: "fg-gas-backend",
  payload: EDITED,
  note: NOTE,
  revision: 0,
  ...overrides,
});

const refusedWith = async (command) =>
  editInboxEventPayloadUseCase(command).catch((error) => error.output);

beforeEach(() => {
  withTransaction.mockImplementation(async (run) => run(SESSION));
  findEditableById.mockResolvedValue({ _id: ID, event: STORED });
  editPayloadById.mockResolvedValue(true);
});

describe("editInboxEventPayloadUseCase", () => {
  it("answers the new revision, where the payload changed and the hashes", async () => {
    expect(await editInboxEventPayloadUseCase(aCommand())).toEqual({
      payloadRevision: 1,
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
      beforeHash: payloadHash(STORED),
      afterHash: payloadHash(EDITED),
    });
  });

  it("reads the stored payload inside the transaction", async () => {
    await editInboxEventPayloadUseCase(aCommand());

    expect(findEditableById).toHaveBeenCalledWith(ID, SESSION);
  });

  it("writes the fenced update with the edit and the stored original", async () => {
    await editInboxEventPayloadUseCase(aCommand({ revision: 2 }));

    expect(editPayloadById).toHaveBeenCalledWith(ID, {
      event: EDITED,
      by: "ada",
      note: NOTE,
      revision: 2,
      original: STORED,
      session: SESSION,
    });
  });

  it("keeps no original once the row has been edited", async () => {
    findEditableById.mockResolvedValue({
      _id: ID,
      event: STORED,
      lastEdit: { at: "t", by: "ada", note: "n" },
    });

    await editInboxEventPayloadUseCase(aCommand({ revision: 2 }));

    expect(editPayloadById).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ original: undefined }),
    );
  });

  it("does not read the status again on the happy path", async () => {
    await editInboxEventPayloadUseCase(aCommand());

    expect(findStatusById).not.toHaveBeenCalled();
  });

  it("404s when the row is not there to read", async () => {
    findEditableById.mockResolvedValue(null);

    expect((await refusedWith(aCommand())).statusCode).toBe(404);
    expect(editPayloadById).not.toHaveBeenCalled();
  });

  it.each([
    ["UNCHANGED", STORED],
    ["DOLLAR_KEY", { ...EDITED, $set: {} }],
    ["TOO_LARGE", { big: "x".repeat(256 * 1024) }],
    ["NOT_AN_OBJECT", []],
  ])("422s %s before writing anything", async (reason, payload) => {
    const output = await refusedWith(aCommand({ payload }));

    expect(output.statusCode).toBe(422);
    expect(output.payload.reason).toBe(reason);
    expect(editPayloadById).not.toHaveBeenCalled();
  });

  it("404s when the row went between the read and the update", async () => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue(null);

    expect((await refusedWith(aCommand())).statusCode).toBe(404);
  });

  it.each(["COMPLETED", "RESUBMITTED", "PUBLISHED"])(
    "409s with the status when the row is %s",
    async (status) => {
      editPayloadById.mockResolvedValue(false);
      findStatusById.mockResolvedValue(status);

      const output = await refusedWith(aCommand());

      expect(output.statusCode).toBe(409);
      expect(output.payload.status).toBe(status);
      expect(output.payload.message).toContain(
        "not editable (DEAD_LETTER or PURGED)",
      );
    },
  );

  it.each(["DEAD_LETTER", "PURGED"])(
    "412s when the %s row was edited since the revision",
    async (status) => {
      editPayloadById.mockResolvedValue(false);
      findStatusById.mockResolvedValue(status);

      expect((await refusedWith(aCommand())).statusCode).toBe(412);
    },
  );

  it("reads the refused row's status inside the transaction too", async () => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("COMPLETED");

    await refusedWith(aCommand());

    expect(findStatusById).toHaveBeenCalledWith(ID, SESSION);
  });

  it("never logs the payload or the note", async () => {
    await editInboxEventPayloadUseCase(aCommand());
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("DEAD_LETTER");
    await refusedWith(aCommand());

    const logged = JSON.stringify(
      Object.values(logger).flatMap((log) => log.mock.calls),
    );

    expect(logged).not.toMatch(/Ada Lovelace|Grace Hopper/);
  });
});

// This service audits its own state change, and the row and that record commit
// together or not at all.
describe("editInboxEventPayloadUseCase audit", () => {
  it("runs the edit and its audit inside one transaction", async () => {
    await editInboxEventPayloadUseCase(aCommand());

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SUCCESS" }),
      SESSION,
    );
  });

  it("records the edit against the event with paths and hashes", async () => {
    await editInboxEventPayloadUseCase(
      aCommand({ by: "donatas", caller: "gas", revision: 0 }),
    );

    const [payload] = writeAuditEvent.mock.calls[0];

    expect(payload.entities).toEqual([
      { entity: "EVENT", action: "EDIT_EVENT_PAYLOAD", entityid: ID },
    ]);
    expect(payload.details.event).toEqual({
      box: "inbox",
      actor: "donatas",
      caller: "gas",
      revision: 0,
      changedPaths: ["/data/amount"],
      changedPathsTruncated: false,
      beforeHash: payloadHash(STORED),
      afterHash: payloadHash(EDITED),
    });
    expect(payload.security).toEqual({ pmccode: "0706" });
    expect(payload.segregationRef).toBe(`edit-event-${ID}`);
  });

  it("keeps the note and every payload value out of the audit event", async () => {
    await editInboxEventPayloadUseCase(aCommand());

    const serialised = JSON.stringify(writeAuditEvent.mock.calls[0][0]);

    expect(serialised).not.toContain("Ada Lovelace");
    expect(serialised).not.toContain("Grace Hopper");
    expect(serialised).not.toContain('"12"');
    expect(serialised).not.toContain("evt-1");
  });

  // A refused attempt is still an attempt, so it is recorded outside the
  // aborted transaction - with no paths, because nothing changed.
  it("records a refused edit as a FAILURE with its reason and no paths", async () => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("DEAD_LETTER");

    await refusedWith(aCommand({ revision: 4 }));

    const [payload, session] = writeAuditEvent.mock.calls[0];

    expect(session).toBeNull();
    expect(payload.status).toBe("FAILURE");
    expect(payload.details.event).toEqual({
      box: "inbox",
      actor: "ada",
      caller: "fg-gas-backend",
      revision: 4,
      reason: "STALE",
    });
  });

  it("records a 422 refusal as a FAILURE too, with its reason", async () => {
    await refusedWith(aCommand({ payload: STORED }));

    expect(writeAuditEvent.mock.calls[0][0].status).toBe("FAILURE");
    expect(writeAuditEvent.mock.calls[0][0].details.event.reason).toBe(
      "UNCHANGED",
    );
  });

  it.each([
    ["NOT_FOUND", null],
    ["NOT_EDITABLE", "COMPLETED"],
  ])("records the reason %s on a FAILURE", async (reason, status) => {
    editPayloadById.mockResolvedValue(false);
    findStatusById.mockResolvedValue(status);

    await refusedWith(aCommand());

    expect(writeAuditEvent.mock.calls[0][0].details.event.reason).toBe(reason);
  });

  // A swallowed audit failure would leave the payload edited with nothing
  // recording it. Rethrowing aborts the transaction instead.
  it("fails the edit when the audit event cannot be written", async () => {
    writeAuditEvent.mockRejectedValue(new Error("outbox insert failed"));

    await expect(editInboxEventPayloadUseCase(aCommand())).rejects.toThrow(
      "outbox insert failed",
    );
  });

  it("lets the audit failure escape the transaction callback", async () => {
    writeAuditEvent.mockRejectedValue(new Error("outbox insert failed"));

    let escaped = null;
    withTransaction.mockImplementation(async (run) => {
      try {
        return await run(SESSION);
      } catch (error) {
        escaped = error;
        throw error;
      }
    });

    await expect(editInboxEventPayloadUseCase(aCommand())).rejects.toThrow(
      "outbox insert failed",
    );
    expect(escaped).toBeInstanceOf(Error);
  });
});
