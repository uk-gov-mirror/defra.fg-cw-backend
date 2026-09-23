import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditStatus } from "./audit-constants.js";
import { withAudit } from "./with-audit.js";
import { writeAuditEvent } from "./write-audit-event.js";

vi.mock("./write-audit-event.js", () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock("./logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("withAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeAuditEvent.mockResolvedValue(undefined);
  });

  describe("success path", () => {
    it("returns the result of the wrapped function", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockReturnValue({
        accounts: undefined,
        entities: [],
        details: {},
        messageGroupId: "msg-1",
      });

      const result = await withAudit(fn, dataBuilder)("arg0");

      expect(result).toEqual({ id: "123" });
    });

    it("calls the wrapped function with the provided args", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0", "session-id");

      expect(fn).toHaveBeenCalledWith("arg0", "session-id");
    });

    it("calls dataBuilder with args array and result", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0", "session-id");

      expect(dataBuilder).toHaveBeenCalledWith(
        ["arg0", "session-id"],
        { id: "123" },
        undefined,
      );
    });

    it("writes the audit event with entities and details from dataBuilder", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockReturnValue({
        entities: [{ entity: "USER", action: "LOGIN", entityid: "user-1" }],
        details: { security: { actor: { id: "user-1" } } },
      });

      await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          entities: [{ entity: "USER", action: "LOGIN", entityid: "user-1" }],
          details: { security: { actor: { id: "user-1" } } },
        }),
        "my-session",
      );
    });

    it("forwards the dataBuilder segregationRef to writeAuditEvent", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockReturnValue({
        entities: [],
        details: {},
        segregationRef: "login-idp-1",
      });

      await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ segregationRef: "login-idp-1" }),
        "my-session",
      );
    });

    it("passes the top-level security field from dataBuilder through to writeAuditEvent", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockReturnValue({
        entities: [],
        details: {},
        security: { pmccode: "TBC" },
      });

      await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ security: { pmccode: "TBC" } }),
        "my-session",
      );
    });

    it("passes args[1] as the session to writeAuditEvent", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.anything(),
        "my-session",
      );
    });

    it("writes SUCCESS status on success", async () => {
      const fn = vi.fn().mockResolvedValue(undefined);
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: auditStatus.SUCCESS }),
        "my-session",
      );
    });

    it("skips writing the audit event when dataBuilder returns null", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockReturnValue(null);

      const result = await withAudit(fn, dataBuilder)("arg0", "my-session");

      expect(result).toEqual({ id: "123" });
      expect(writeAuditEvent).not.toHaveBeenCalled();
    });

    it("does not propagate writeAuditEvent errors", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });
      writeAuditEvent.mockRejectedValue(new Error("SNS unavailable"));

      await expect(withAudit(fn, dataBuilder)("arg0")).resolves.toEqual({
        id: "123",
      });
    });

    it("does not propagate dataBuilder errors", async () => {
      const fn = vi.fn().mockResolvedValue({ id: "123" });
      const dataBuilder = vi.fn().mockImplementation(() => {
        throw new Error("builder failed");
      });

      await expect(withAudit(fn, dataBuilder)("arg0")).resolves.toEqual({
        id: "123",
      });
    });
  });

  describe("failure path", () => {
    it("rethrows when the wrapped function throws", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("use case failed"));
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await expect(withAudit(fn, dataBuilder)("arg0")).rejects.toThrow(
        "use case failed",
      );
    });

    it("writes a FAILURE audit event when the wrapped function throws", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("use case failed"));
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0").catch(() => {});

      expect(writeAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: auditStatus.FAILURE }),
        null,
      );
    });

    it("passes null as the session when the wrapped function throws", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("use case failed"));
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0", "my-session").catch(() => {});

      expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), null);
    });

    it("calls dataBuilder with undefined result and the error when the wrapped function throws", async () => {
      const failure = new Error("use case failed");
      const fn = vi.fn().mockRejectedValue(failure);
      const dataBuilder = vi
        .fn()
        .mockReturnValue({ entities: [], details: {} });

      await withAudit(fn, dataBuilder)("arg0").catch(() => {});

      expect(dataBuilder).toHaveBeenCalledWith(["arg0"], undefined, failure);
    });

    it("rethrows the original error even when dataBuilder throws", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("use case failed"));
      const dataBuilder = vi.fn().mockImplementation(() => {
        throw new Error("builder failed");
      });

      await expect(withAudit(fn, dataBuilder)("arg0")).rejects.toThrow(
        "use case failed",
      );
    });
  });
});
