import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findStatusById,
  purgeById,
} from "../../cases/repositories/outbox.repository.js";
import { withTransaction } from "../../common/with-transaction.js";
import { writeAuditEvent } from "../../common/write-audit-event.js";
import { purgeOutboxEventUseCase } from "./purge-outbox-event.use-case.js";

vi.mock("../../common/mongo-client.js");
vi.mock("../../common/with-transaction.js");
vi.mock("../../common/write-audit-event.js");
vi.mock("../../cases/repositories/outbox.repository.js");

const ID = "665f1c2e9a1b2c3d4e5f6a7b";

// The session `withTransaction` hands a real caller. Everything that has to
// join the transaction is asserted against this exact object.
const SESSION = { id: "the-transaction" };

const aCommand = (overrides = {}) => ({
  id: ID,
  by: "ada",
  caller: "fg-gas-backend",
  reasonCode: "BROKEN_PAYLOAD",
  note: null,
  ...overrides,
});

beforeEach(() => {
  withTransaction.mockImplementation(async (run) => run(SESSION));
});

describe("purgeOutboxEventUseCase", () => {
  it("issues the conditional update by id, with the reason and the operator", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(
      aCommand({ reasonCode: "OTHER", note: "asked for by the grant team" }),
    );

    expect(purgeById).toHaveBeenCalledWith(ID, {
      by: "ada",
      reasonCode: "OTHER",
      note: "asked for by the grant team",
      session: SESSION,
    });
  });

  it("answers with nothing once the row is purged", async () => {
    purgeById.mockResolvedValue(true);

    expect(await purgeOutboxEventUseCase(aCommand())).toBeUndefined();
  });

  it("does not read the status again on the happy path", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(aCommand());

    expect(findStatusById).not.toHaveBeenCalled();
  });

  // "System" is the log line's display wording for a purge; the row keeps the
  // operator the route insisted on and nothing else.
  it("stores the operator verbatim", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(aCommand({ by: "donatas" }));

    expect(purgeById).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ by: "donatas" }),
    );
    expect(JSON.stringify(purgeById.mock.calls.at(-1))).not.toContain("System");
  });

  it("404s when the conditional update matched nothing and the row is gone", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue(null);

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toMatchObject({
      output: { statusCode: 404 },
    });
  });

  it("409s when the row is not DEAD_LETTER", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("COMPLETED");

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toMatchObject({
      output: { statusCode: 409 },
    });
  });

  it("puts the current status in the 409 body", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("PUBLISHED");

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toMatchObject({
      output: { payload: { statusCode: 409, status: "PUBLISHED" } },
    });
  });

  it("409s on a purge of an already purged row", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("PURGED");

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toMatchObject({
      output: { payload: { status: "PURGED" } },
    });
  });

  // The race: the row was DEAD_LETTER when the page rendered, but a redrive
  // landed first, so the update matches nothing.
  it("loses cleanly to a concurrent redrive", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("RESUBMITTED");

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toMatchObject({
      output: { payload: { status: "RESUBMITTED" } },
    });
    expect(purgeById).toHaveBeenCalledTimes(1);
  });
});

// This service audits its own state change, and the row and that record commit
// together or not at all.
describe("purgeOutboxEventUseCase transaction", () => {
  it("runs the purge and its audit inside one transaction", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(aCommand());

    expect(withTransaction).toHaveBeenCalledTimes(1);
    // The same session reaches the row update and the audit's outbox insert -
    // which is what makes them one commit.
    expect(purgeById).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ session: SESSION }),
    );
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "SUCCESS" }),
      SESSION,
    );
  });

  it("reads the refused row's status inside the transaction too", async () => {
    purgeById.mockResolvedValue(false);
    findStatusById.mockResolvedValue("COMPLETED");

    await purgeOutboxEventUseCase(aCommand()).catch(() => {});

    expect(findStatusById).toHaveBeenCalledWith(ID, SESSION);
  });

  it("records the purge against the event, naming actor, caller and reason", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(aCommand({ by: "donatas", caller: "gas" }));

    const [payload] = writeAuditEvent.mock.calls[0];

    expect(payload.entities).toEqual([
      { entity: "EVENT", action: "PURGE_EVENT", entityid: ID },
    ]);
    expect(payload.details.event).toEqual({
      box: "outbox",
      actor: "donatas",
      caller: "gas",
      reasonCode: "BROKEN_PAYLOAD",
    });
    expect(payload.segregationRef).toBe(`purge-event-${ID}`);
  });

  // The note is free text about whoever the event concerned; the row holds it
  // and the audit event does not.
  it("keeps the note out of the audit event", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(
      aCommand({ reasonCode: "OTHER", note: "chased by Ada Lovelace" }),
    );

    const [payload] = writeAuditEvent.mock.calls[0];

    expect(payload.details.event).not.toHaveProperty("note");
    expect(JSON.stringify(payload)).not.toContain("Ada Lovelace");
  });

  // The route requires an operator, so the audit event always names one - never
  // the log line's "System" wording.
  it("records the operator as the audit actor", async () => {
    purgeById.mockResolvedValue(true);

    await purgeOutboxEventUseCase(aCommand({ by: "ada" }));

    const [payload] = writeAuditEvent.mock.calls[0];

    expect(payload.details.event.actor).toBe("ada");
    expect(JSON.stringify(payload)).not.toContain("System");
  });

  // A swallowed audit failure would leave the row purged with nothing
  // recording it. Rethrowing aborts the transaction instead.
  it("fails the purge when the audit event cannot be written", async () => {
    purgeById.mockResolvedValue(true);
    writeAuditEvent.mockRejectedValue(new Error("outbox insert failed"));

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toThrow(
      "outbox insert failed",
    );
  });

  it("fails the purge when the audit payload will not validate", async () => {
    purgeById.mockResolvedValue(true);
    writeAuditEvent.mockRejectedValue(
      new Error("Audit event failed validation"),
    );

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toThrow(
      "Audit event failed validation",
    );
  });

  // The abort is the transaction's job, so what this pins is that the error
  // escapes the callback - the only way a real transaction rolls the row back.
  it("lets the audit failure escape the transaction callback", async () => {
    purgeById.mockResolvedValue(true);
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

    await expect(purgeOutboxEventUseCase(aCommand())).rejects.toThrow(
      "outbox insert failed",
    );
    expect(escaped).toBeInstanceOf(Error);
  });
});
