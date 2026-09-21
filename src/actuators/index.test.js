import { describe, expect, it, vi } from "vitest";
import { createServer } from "../server/index.js";
import { PUBLIC_API_STRATEGY } from "../server/plugins/auth/public-api.js";
import { actuators } from "./index.js";
import { eventIdParams } from "./schemas/event-id.schema.js";

vi.mock("../common/mongo-client.js");

const registeredServer = async () => {
  const server = await createServer();

  await server.register(actuators);
  await server.initialize();

  return server;
};

describe("actuators", () => {
  it("registers the page, the detail, the redrive and the purge routes", async () => {
    const server = await registeredServer();

    const actuatorPaths = server
      .table()
      .map((route) => route.path)
      .filter((path) => path.startsWith("/actuators"))
      .sort();

    expect(actuatorPaths).toEqual([
      "/actuators/events",
      "/actuators/events/inbox/{id}",
      "/actuators/events/inbox/{id}/purge",
      "/actuators/events/inbox/{id}/redrive",
      "/actuators/events/outbox/{id}",
      "/actuators/events/outbox/{id}/purge",
      "/actuators/events/outbox/{id}/redrive",
    ]);
  });

  // The six per-box endpoints the page composite replaced. Asserted absent
  // rather than merely unlisted: they were a service-token API surface, and a
  // retirement nobody notices is one that quietly comes back.
  it.each([
    "/actuators/inbox",
    "/actuators/outbox",
    "/actuators/inbox/counts",
    "/actuators/outbox/counts",
    "/actuators/inbox/breakdown",
    "/actuators/outbox/breakdown",
  ])("no longer answers %s", async (path) => {
    const server = await registeredServer();

    expect(server.table().map((r) => r.path)).not.toContain(path);
  });

  it("still routes a 24-hex id to the detail route", async () => {
    const server = await registeredServer();

    expect(
      server.match("get", "/actuators/events/inbox/665f1c2e9a1b2c3d4e5f6a7b")
        .path,
    ).toBe("/actuators/events/inbox/{id}");
  });

  // The `/actuators/events` prefix put the collection and its members on
  // different depths, so no literal can be read as an id any more. The id
  // constraint that made the retired `/counts` and `/breakdown` paths safe is
  // kept anyway: it is what keeps a word out of the detail route at all.
  it("could not accept a word where an id belongs", () => {
    expect(eventIdParams.validate({ id: "events" }).error).toBeDefined();
    expect(eventIdParams.validate({ id: "counts" }).error).toBeDefined();
  });

  it("keeps every /actuators/* route on the public API strategy", async () => {
    const server = await registeredServer();

    const routes = server
      .table()
      .filter((r) => r.path.startsWith("/actuators"));

    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      expect(route.settings.auth.strategies).toEqual([PUBLIC_API_STRATEGY]);
    }
  });
});
