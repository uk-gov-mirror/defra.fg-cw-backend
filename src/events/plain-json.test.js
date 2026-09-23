import { Binary, Decimal128, Long, ObjectId, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { isPlainJson, isPlainObject, withJsonNumbers } from "./plain-json.js";

const NOT_PLAIN = [
  ["a BSON Date", new Date("2026-06-16T10:00:00.000Z")],
  ["an ObjectId", new ObjectId("665f1c2e9a1b2c3d4e5f6a7b")],
  ["a Long", Long.fromString("9007199254740993")],
  ["a Decimal128", Decimal128.fromString("1.10")],
  ["a Binary", new Binary(Buffer.from("abc"))],
  ["2^53", 2 ** 53],
  ["-(2^53)", -(2 ** 53)],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["undefined", undefined],
];

describe("isPlainJson", () => {
  it("is true for plain nested objects and arrays", () => {
    expect(
      isPlainJson({
        id: "evt-1",
        data: {
          amount: 12.5,
          count: 3,
          ok: true,
          none: null,
          list: [1, "two", { three: [false] }],
        },
      }),
    ).toBe(true);
  });

  it.each([null, "", 0, -0, 1.5, 2 ** 53 - 1, -(2 ** 53 - 1), false, []])(
    "is true for %s",
    (value) => {
      expect(isPlainJson(value)).toBe(true);
    },
  );

  it.each(NOT_PLAIN)("is false for %s nested in an object", (_, value) => {
    expect(isPlainJson({ data: { value } })).toBe(false);
  });

  it.each(NOT_PLAIN)("is false for %s nested in an array", (_, value) => {
    expect(isPlainJson({ data: [1, [value]] })).toBe(false);
  });

  it("keeps a plain key named constructor plain", () => {
    expect(isPlainJson({ constructor: 1 })).toBe(true);
  });

  it("is false for an object with another prototype", () => {
    expect(isPlainJson({ data: new Map() })).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("is true for an object literal, even one with a constructor key", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ constructor: "x" })).toBe(true);
  });

  it.each([null, [], "x", 1, new Date(), undefined])(
    "is false for %s",
    (value) => {
      expect(isPlainObject(value)).toBe(false);
    },
  );
});

describe("withJsonNumbers", () => {
  it("gives a Long past 2^53 as its exact decimal text", () => {
    expect(withJsonNumbers(Long.fromString("9007199254740993"))).toBe(
      "9007199254740993",
    );
    expect(withJsonNumbers(Long.fromString("-9007199254740993"))).toBe(
      "-9007199254740993",
    );
  });

  it("gives a safe Long as a number", () => {
    expect(withJsonNumbers(Long.fromNumber(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("gives a Decimal128 as its exact decimal text", () => {
    expect(withJsonNumbers(Decimal128.fromString("1.10"))).toBe("1.10");
  });

  it("gives a Timestamp as a number, not a $ key", () => {
    expect(withJsonNumbers(new Timestamp({ t: 0, i: 7 }))).toBe(7);
  });

  it("converts them inside objects and arrays, leaving other values alone", () => {
    const at = new Date("2026-06-16T10:00:00.000Z");
    const ref = new ObjectId();

    expect(
      withJsonNumbers({
        data: {
          big: Long.fromString("9007199254740993"),
          amounts: [Decimal128.fromString("0.1"), 2],
          at,
          ref,
          name: "a",
        },
      }),
    ).toEqual({
      data: {
        big: "9007199254740993",
        amounts: ["0.1", 2],
        at,
        ref,
        name: "a",
      },
    });
  });

  it("keeps a key named __proto__ as an ordinary key", () => {
    const payload = JSON.parse('{"__proto__": {"a": 1}}');

    expect(Object.hasOwn(withJsonNumbers(payload), "__proto__")).toBe(true);
  });
});
