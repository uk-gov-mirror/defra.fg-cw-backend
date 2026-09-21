import { describe, expect, it } from "vitest";
import {
  actorQuery,
  pageQuery,
  requiredActorQuery,
} from "./box-query.schema.js";

describe("pageQuery", () => {
  it("accepts status=PURGED, so the admin can filter the tile", () => {
    expect(pageQuery.validate({ status: "PURGED" }).error).toBeUndefined();
  });
});

describe("actorQuery", () => {
  it("accepts an operator name", () => {
    expect(actorQuery.validate({ by: "donatas" }).error).toBeUndefined();
  });

  it("is optional - an unattributed mutation is still a mutation", () => {
    expect(actorQuery.validate({}).error).toBeUndefined();
  });

  it("caps the actor at 128 characters", () => {
    expect(actorQuery.validate({ by: "x".repeat(128) }).error).toBeUndefined();
    expect(actorQuery.validate({ by: "x".repeat(129) }).error).toBeDefined();
  });
});

describe("requiredActorQuery", () => {
  it("accepts an operator name", () => {
    expect(
      requiredActorQuery.validate({ by: "donatas" }).error,
    ).toBeUndefined();
  });

  it("rejects a missing operator - the audit record would name nobody", () => {
    expect(requiredActorQuery.validate({}).error).toBeDefined();
  });

  it("rejects a blank operator, which is a missing one spelled differently", () => {
    expect(requiredActorQuery.validate({ by: "" }).error).toBeDefined();
    expect(requiredActorQuery.validate({ by: "   " }).error).toBeDefined();
  });

  it("trims and caps the actor the same way", () => {
    expect(requiredActorQuery.validate({ by: "  ada  " }).value.by).toBe("ada");
    expect(
      requiredActorQuery.validate({ by: "x".repeat(129) }).error,
    ).toBeDefined();
  });
});
