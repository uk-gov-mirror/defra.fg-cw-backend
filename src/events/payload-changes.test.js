import { Decimal128, Long } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  CHANGED_PATHS_MAX,
  payloadChanges,
  payloadHash,
} from "./payload-changes.js";

const pathsOf = (before, after) => payloadChanges(before, after).changedPaths;

describe("payloadChanges", () => {
  it("finds nothing when the payloads are equal", () => {
    expect(
      payloadChanges(
        { a: 1, b: [1, { c: "x" }] },
        { a: 1, b: [1, { c: "x" }] },
      ),
    ).toEqual({ changedPaths: [], changedPathsTruncated: false });
  });

  it("ignores key order", () => {
    expect(pathsOf({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it("names a changed, an added and a removed key as JSON Pointers", () => {
    expect(
      pathsOf(
        { data: { amount: "12", gone: true } },
        { data: { amount: 12, added: 1 } },
      ),
    ).toEqual(["/data/amount", "/data/gone", "/data/added"]);
  });

  it("reports array changes by index", () => {
    expect(pathsOf({ list: [1, 2, 3] }, { list: [1, 5, 3, 4] })).toEqual([
      "/list/1",
      "/list/3",
    ]);
  });

  it("reports a removed array element by index", () => {
    expect(pathsOf({ list: ["a", "b"] }, { list: ["a"] })).toEqual(["/list/1"]);
  });

  it.each([
    ["an object for an array", { x: [] }, { x: {} }],
    ["an array for an object", { x: {} }, { x: [] }],
    ["a string for a number", { x: 1 }, { x: "1" }],
    ["null for an object", { x: { y: 1 } }, { x: null }],
    ["an object for a string", { x: "y" }, { x: { y: 1 } }],
  ])("reports %s as one change at that path", (_, before, after) => {
    expect(pathsOf(before, after)).toEqual(["/x"]);
  });

  it("reports a stored BSON value replaced by its JSON form", () => {
    const at = new Date("2026-06-16T10:00:00.000Z");

    expect(pathsOf({ at }, { at: at.toISOString() })).toEqual(["/at"]);
  });

  it("reports a stored BSON number replaced by its JSON text, as a Date is", () => {
    expect(
      pathsOf(
        {
          big: Long.fromString("9007199254740993"),
          amount: Decimal128.fromString("1.10"),
        },
        { big: "9007199254740993", amount: "1.10" },
      ),
    ).toEqual(["/big", "/amount"]);
  });

  it("names the root with the empty pointer when the whole payload changes type", () => {
    expect(pathsOf(null, { a: 1 })).toEqual([""]);
  });

  it.each(["__proto__", "toString", "constructor", "hasOwnProperty"])(
    "treats a %s key as an ordinary key",
    (key) => {
      const withKey = JSON.parse(`{"data":{"${key}":1}}`);

      expect(pathsOf({ data: {} }, withKey)).toEqual([`/data/${key}`]);
      expect(pathsOf(withKey, { data: {} })).toEqual([`/data/${key}`]);
      expect(pathsOf(withKey, withKey)).toEqual([]);
    },
  );

  it("escapes ~ and / in keys and leaves dots alone", () => {
    expect(pathsOf({}, { "a/b": 1, "c~d": 1, "e.f": 1, "~/": 1 })).toEqual([
      "/a~1b",
      "/c~0d",
      "/e.f",
      "/~0~1",
    ]);
  });

  it("never puts a value in a path", () => {
    const { changedPaths } = payloadChanges(
      { data: { name: "Ada Lovelace" } },
      { data: { name: "Grace Hopper" } },
    );

    expect(JSON.stringify(changedPaths)).not.toMatch(/Ada|Grace/);
  });

  it(`caps the list at ${CHANGED_PATHS_MAX} and says it was cut`, () => {
    const after = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`k${i}`, i]),
    );

    const { changedPaths, changedPathsTruncated } = payloadChanges({}, after);

    expect(changedPaths).toHaveLength(CHANGED_PATHS_MAX);
    expect(changedPaths[0]).toBe("/k0");
    expect(changedPathsTruncated).toBe(true);
  });

  it("does not call a list of exactly the cap truncated", () => {
    const after = Object.fromEntries(
      Array.from({ length: CHANGED_PATHS_MAX }, (_, i) => [`k${i}`, i]),
    );

    expect(payloadChanges({}, after)).toMatchObject({
      changedPathsTruncated: false,
    });
    expect(pathsOf({}, after)).toHaveLength(CHANGED_PATHS_MAX);
  });
});

describe("payloadHash", () => {
  it("is the sha256 of the JSON text", () => {
    expect(payloadHash({ a: 1 })).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  it("differs when the payload does", () => {
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });

  it("hashes a missing payload as null", () => {
    expect(payloadHash(undefined)).toBe(payloadHash(null));
  });

  it("hashes a BSON number as the JSON text the editor is given", () => {
    expect(
      payloadHash({
        big: Long.fromString("9007199254740993"),
        amount: Decimal128.fromString("1.10"),
      }),
    ).toBe(payloadHash({ big: "9007199254740993", amount: "1.10" }));
  });
});
