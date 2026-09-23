// By prototype rather than `constructor`, so a payload key named `constructor`
// is just a key.
export const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

// An integer outside the safe range would come back from a JSON round trip as
// a different number.
const isPlainNumber = (value) =>
  Number.isFinite(value) &&
  (Number.isSafeInteger(value) || !Number.isInteger(value));

const PLAIN_SCALARS = {
  string: () => true,
  boolean: () => true,
  number: isPlainNumber,
};

// Anything else - undefined, a function, a bigint - has no JSON form at all.
const isPlainScalar = (value) =>
  Object.hasOwn(PLAIN_SCALARS, typeof value) &&
  PLAIN_SCALARS[typeof value](value);

const isPlainContainer = (value) =>
  Array.isArray(value)
    ? value.every(isPlainJson)
    : isPlainObject(value) && Object.values(value).every(isPlainJson);

// Whether a JSON round trip would give the value back unchanged. A BSON Date,
// ObjectId, Long, Decimal128 or Binary would come back as its JSON form, so a
// save through the editor would change it.
export const isPlainJson = (value) => {
  if (value === null) {
    return true;
  }

  if (typeof value === "object") {
    return isPlainContainer(value);
  }

  return isPlainScalar(value);
};

const safeOrText = (value) => {
  const number = value.toNumber();

  return Number.isSafeInteger(number) ? number : value.toString();
};

// A Timestamp is a Long.
const BSON_NUMBERS = {
  Long: safeOrText,
  Timestamp: safeOrText,
  Decimal128: (value) => value.toString(),
};

const withJsonNumber = (value) =>
  BSON_NUMBERS[value?._bsontype]?.(value) ?? value;

const withJsonNumbersIn = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, withJsonNumbers(child)]),
  );

// Each BSON number as the JSON an edit can send back: a number where it is
// exact, its decimal text where it is not. Their own JSON forms are an object
// and a `$` key. Other values are left to `JSON.stringify`, which gives a Date
// its ISO text.
export const withJsonNumbers = (value) => {
  if (Array.isArray(value)) {
    return value.map(withJsonNumbers);
  }

  if (isPlainObject(value)) {
    return withJsonNumbersIn(value);
  }

  return withJsonNumber(value);
};
