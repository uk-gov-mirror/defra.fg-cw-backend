import { createHash } from "node:crypto";
import { isPlainObject, withJsonNumbers } from "./plain-json.js";

// Enough to say where an edit landed without the list becoming a copy of the
// payload's shape.
export const CHANGED_PATHS_MAX = 50;

const MISSING = Symbol("missing");

// Own keys only, so `__proto__`, `toString` and `constructor` are ordinary
// keys rather than whatever the prototype holds.
const own = (container, key) =>
  Object.hasOwn(container, key) ? container[key] : MISSING;

const kindOf = (value) => {
  if (Array.isArray(value)) {
    return "array";
  }

  return isPlainObject(value) ? "object" : "leaf";
};

const CHILD_KEYS = {
  array: (before, after) =>
    Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i),
  object: (before, after) => [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ],
};

// RFC 6901. `~` first, so the `~1` a slash becomes is not escaped again.
const escapeSegment = (key) =>
  String(key).replaceAll("~", "~0").replaceAll("/", "~1");

// The kind both sides share when there is something to recurse into, or null
// when the path is compared as a whole - a type change is one change.
const sharedContainer = (before, after) => {
  const kind = kindOf(before);

  return kind !== "leaf" && kind === kindOf(after) ? kind : null;
};

const walkChildren = (kind, before, after, path, found) => {
  for (const key of CHILD_KEYS[kind](before, after)) {
    walk(
      own(before, key),
      own(after, key),
      `${path}/${escapeSegment(key)}`,
      found,
    );
  }
};

// Stops one past the cap: that is all it takes to know the list was cut.
const walk = (before, after, path, found) => {
  if (found.length > CHANGED_PATHS_MAX) {
    return;
  }

  const kind = sharedContainer(before, after);

  if (kind) {
    walkChildren(kind, before, after, path, found);
  } else if (before !== after) {
    found.push(path);
  }
};

// Where the payload changed, as JSON Pointers. Never what it changed from or
// to: the paths go into the audit event and the values are applicant data.
export const payloadChanges = (before, after) => {
  const found = [];

  walk(before, after, "", found);

  return {
    changedPaths: found.slice(0, CHANGED_PATHS_MAX),
    changedPathsTruncated: found.length > CHANGED_PATHS_MAX,
  };
};

// Of the JSON the editor is given, so an untouched BSON number hashes as its text.
export const payloadHash = (payload) =>
  createHash("sha256")
    .update(JSON.stringify(withJsonNumbers(payload ?? null)))
    .digest("hex");
