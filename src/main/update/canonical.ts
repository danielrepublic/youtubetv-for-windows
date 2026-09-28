/**
 * Canonical serialization for the signed update manifest.
 *
 * ---------------------------------------------------------------------------
 * THE RULE (signer and verifier must agree byte-for-byte)
 * ---------------------------------------------------------------------------
 * The signed payload is the UTF-8 encoding of the manifest object serialized
 * as JSON with:
 *
 *   1. Object keys sorted ascending by their raw UTF-16 code units
 *      (JavaScript's default `Array.prototype.sort` order), recursively at
 *      every nesting level. Arrays keep their declared order.
 *   2. No insignificant whitespace: no spaces after `:` or `,`, no newlines.
 *   3. Strings escaped exactly as ECMAScript `JSON.stringify` escapes them:
 *      `"` and `\` are escaped, C0 control characters use the short escapes
 *      `\b \f \n \r \t` where defined and `\u00XX` otherwise. Non-ASCII
 *      characters are emitted raw as UTF-8 (not `\uXXXX` escapes).
 *   4. Numbers formatted exactly as ECMAScript `JSON.stringify` formats them
 *      (shortest round-trip representation; `-0` renders as `0`). `NaN`,
 *      `Infinity`, and non-finite numbers are rejected because JSON cannot
 *      represent them.
 *   5. No trailing newline.
 *
 * The signature is computed over these canonical bytes, never over the bytes
 * actually received from the network. That means the wire format may be
 * pretty-printed, reordered, or re-encoded without invalidating the
 * signature, while any change to a semantic value does invalidate it.
 *
 * Test vector (asserted in `test/update/canonical.test.mjs`):
 *   input : { b: "x", a: [1, true, null, "q\"z"], n: -0.5 }
 *   bytes : {"a":[1,true,null,"q\"z"],"b":"x","n":-0.5}
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function serialize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError(
          "canonical JSON cannot represent a non-finite number",
        );
      }
      const text = JSON.stringify(value);
      // JSON.stringify(number) is typed as string | undefined; for a finite
      // number it always returns text.
      if (text === undefined) {
        throw new TypeError("canonical JSON failed to serialize a number");
      }
      return text;
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (isJsonArray(value)) {
        return `[${value.map((item) => serialize(item)).join(",")}]`;
      }
      const keys = Object.keys(value).sort();
      const members = keys.map((key) => {
        const member = value[key];
        if (member === undefined) {
          throw new TypeError(
            `canonical JSON cannot represent undefined at key ${key}`,
          );
        }
        return `${JSON.stringify(key)}:${serialize(member)}`;
      });
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(
        `canonical JSON cannot represent a value of type ${typeof value}`,
      );
  }
}

/** Returns the canonical JSON text for a JSON-compatible value. */
export function canonicalJsonText(value: JsonValue): string {
  return serialize(value);
}

/** Returns the canonical UTF-8 bytes that the detached signature covers. */
export function canonicalBytes(value: JsonValue): Buffer {
  return Buffer.from(serialize(value), "utf8");
}
