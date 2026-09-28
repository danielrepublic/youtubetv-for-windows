import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalBytes,
  canonicalJsonText,
} from "../../src/main/update/canonical.ts";

test("sorts object keys recursively and drops insignificant whitespace", () => {
  const value = { b: { d: 1, c: 2 }, a: 3, z: [2, 1] };
  assert.equal(canonicalJsonText(value), '{"a":3,"b":{"c":2,"d":1},"z":[2,1]}');
});

test("pins the exact canonical bytes of the documented test vector", () => {
  const value = { b: "x", a: [1, true, null, 'q"z'], n: -0.5 };
  const expected = '{"a":[1,true,null,"q\\"z"],"b":"x","n":-0.5}';
  const text = canonicalJsonText(value);
  assert.equal(text, expected);
  const bytes = canonicalBytes(value);
  assert.deepEqual(
    bytes,
    Buffer.from(expected, "utf8"),
    "canonical bytes must be exactly the UTF-8 of the canonical text",
  );
  assert.equal(bytes.toString("hex"), Buffer.from(expected).toString("hex"));
});

test("key insertion order does not change the canonical bytes", () => {
  const one = { z: 1, a: { y: 2, b: 3 } };
  const two = { a: { b: 3, y: 2 }, z: 1 };
  assert.deepEqual(canonicalBytes(one), canonicalBytes(two));
});

test("arrays keep their declared order", () => {
  assert.equal(canonicalJsonText([3, 1, 2]), "[3,1,2]");
});

test("strings use ECMAScript escaping and raw UTF-8 for non-ASCII", () => {
  const text = canonicalJsonText({ s: "é\n\t" });
  assert.equal(text, '{"s":"é\\n\\t"}');
  assert.ok(
    canonicalBytes({ s: "é" }).includes(Buffer.from("é", "utf8")),
    "non-ASCII characters must be emitted raw, not as \\u escapes",
  );
});

test("negative zero canonicalizes to 0", () => {
  assert.equal(canonicalJsonText({ n: -0 }), '{"n":0}');
});

test("non-finite numbers are rejected instead of serialized", () => {
  assert.throws(() => canonicalJsonText({ n: Number.NaN }), TypeError);
  assert.throws(
    () => canonicalJsonText({ n: Number.POSITIVE_INFINITY }),
    TypeError,
  );
});

test("values outside the JSON data model are rejected", () => {
  assert.throws(
    () => canonicalJsonText({ nested: { nope: undefined } }),
    TypeError,
  );
  assert.throws(() => canonicalJsonText(undefined), TypeError);
});
