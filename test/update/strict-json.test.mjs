import assert from "node:assert/strict";
import test from "node:test";
import {
  isJsonObject,
  parseStrictJson,
} from "../../src/main/update/strict-json.ts";

// Parsed objects use a null prototype on purpose (prototype-pollution
// safety), so comparisons normalize through a JSON round-trip.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("parses a nested document that JSON.parse agrees with", () => {
  const text = '{"a":[1,true,null,"x\\n"],"b":{"c":-2.5e2}}';
  const result = parseStrictJson(text);
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.value), JSON.parse(text));
});

test("rejects a duplicated top-level key", () => {
  const result = parseStrictJson('{"channel":"stable","channel":"beta"}');
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate-json-key");
});

test("rejects a duplicated key nested inside an object", () => {
  const result = parseStrictJson('{"a":{"b":1,"b":2}}');
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate-json-key");
});

test("allows the same key name in different objects", () => {
  const result = parseStrictJson('{"a":{"x":1},"b":{"x":2}}');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.value), { a: { x: 1 }, b: { x: 2 } });
});

test("rejects trailing content after the top-level value", () => {
  const result = parseStrictJson('{"a":1} extra');
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-json");
});

test("rejects invalid escape sequences", () => {
  const result = parseStrictJson('{"a":"\\x"}');
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-json");
});

test("rejects unescaped control characters inside strings", () => {
  const result = parseStrictJson('{"a":"line\nbreak"}');
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-json");
});

test("rejects nesting beyond the depth guard", () => {
  const result = parseStrictJson(`${"[".repeat(70)}0${"]".repeat(70)}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-json");
});

test("a __proto__ key is inert data, not prototype pollution", () => {
  const result = parseStrictJson('{"__proto__":{"polluted":true}}');
  assert.equal(result.ok, true);
  assert.equal(Object.getPrototypeOf(result.value), null);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyNames(result.value), ["__proto__"]);
});

test("tolerates whitespace and decodes unicode escapes", () => {
  const result = parseStrictJson('  {\n\t"a": "\\u00e9"\r\n}  ');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.value), { a: "é" });
});

test("rejects truncated and empty inputs", () => {
  assert.equal(parseStrictJson("").ok, false);
  assert.equal(parseStrictJson("{").ok, false);
  assert.equal(parseStrictJson('{"a":}').ok, false);
});

test("isJsonObject accepts plain objects only", () => {
  assert.equal(isJsonObject({ a: 1 }), true);
  assert.equal(isJsonObject([]), false);
  assert.equal(isJsonObject(null), false);
  assert.equal(isJsonObject("x"), false);
});
