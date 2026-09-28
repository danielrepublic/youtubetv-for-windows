/**
 * A small, dependency-free strict JSON parser for untrusted update input.
 *
 * Why this exists instead of `JSON.parse`: `JSON.parse` cannot see duplicate
 * object keys. For `{"channel":"stable","channel":"beta"}` it silently keeps
 * the last value, so a signed manifest could carry two contradicting values
 * for the same field and different consumers could disagree about which one
 * was signed. This parser rejects a repeated key at any nesting depth.
 *
 * It also rejects input `JSON.parse` would accept-adjacent failures more
 * strictly: trailing content after the top-level value, unescaped control
 * characters, malformed escapes, and nesting deeper than `MAX_DEPTH` (a
 * stack-exhaustion guard for hostile input). Objects are built with a null
 * prototype so a `__proto__` key is inert data, never prototype pollution.
 *
 * Output values are limited to `JsonValue`; there is no date/reviver
 * behavior, no `undefined`, and numbers must be finite.
 */
import type { JsonValue } from "./canonical.ts";

export type StrictJsonFailureCode = "malformed-json" | "duplicate-json-key";

export type StrictJsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  | {
      readonly ok: false;
      readonly code: StrictJsonFailureCode;
      readonly message: string;
    };

const MAX_DEPTH = 64;

class StrictJsonError extends Error {
  readonly code: StrictJsonFailureCode;

  constructor(code: StrictJsonFailureCode, message: string) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

class StrictJsonParser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsonValue {
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) {
      throw new StrictJsonError(
        "malformed-json",
        `unexpected trailing content at offset ${this.#index}`,
      );
    }
    return value;
  }

  #fail(message: string): never {
    throw new StrictJsonError("malformed-json", message);
  }

  #skipWhitespace(): void {
    while (this.#index < this.#text.length) {
      const char = this.#text[this.#index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.#index += 1;
        continue;
      }
      return;
    }
  }

  #parseValue(depth: number): JsonValue {
    if (depth > MAX_DEPTH) {
      this.#fail(`nesting exceeds the maximum depth of ${MAX_DEPTH}`);
    }
    this.#skipWhitespace();
    const char = this.#text[this.#index];
    if (char === undefined) {
      this.#fail("unexpected end of input");
    }
    if (char === "{") {
      return this.#parseObject(depth);
    }
    if (char === "[") {
      return this.#parseArray(depth);
    }
    if (char === '"') {
      return this.#parseString();
    }
    if (char === "t" || char === "f" || char === "n") {
      return this.#parseLiteral();
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      return this.#parseNumber();
    }
    this.#fail(`unexpected character ${JSON.stringify(char)}`);
  }

  #parseObject(depth: number): JsonValue {
    this.#index += 1; // consume "{"
    const object: Record<string, JsonValue> = Object.create(null);
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.#text[this.#index] === "}") {
      this.#index += 1;
      return object;
    }
    for (;;) {
      this.#skipWhitespace();
      if (this.#text[this.#index] !== '"') {
        this.#fail(`expected an object key at offset ${this.#index}`);
      }
      const key = this.#parseString();
      if (keys.has(key)) {
        throw new StrictJsonError(
          "duplicate-json-key",
          `duplicate object key ${JSON.stringify(key)} at offset ${this.#index}`,
        );
      }
      keys.add(key);
      this.#skipWhitespace();
      if (this.#text[this.#index] !== ":") {
        this.#fail(`expected ":" after object key at offset ${this.#index}`);
      }
      this.#index += 1;
      object[key] = this.#parseValue(depth + 1);
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      if (separator === ",") {
        this.#index += 1;
        continue;
      }
      if (separator === "}") {
        this.#index += 1;
        return object;
      }
      this.#fail(`expected "," or "}" at offset ${this.#index}`);
    }
  }

  #parseArray(depth: number): JsonValue {
    this.#index += 1; // consume "["
    const array: JsonValue[] = [];
    this.#skipWhitespace();
    if (this.#text[this.#index] === "]") {
      this.#index += 1;
      return array;
    }
    for (;;) {
      array.push(this.#parseValue(depth + 1));
      this.#skipWhitespace();
      const separator = this.#text[this.#index];
      if (separator === ",") {
        this.#index += 1;
        continue;
      }
      if (separator === "]") {
        this.#index += 1;
        return array;
      }
      this.#fail(`expected "," or "]" at offset ${this.#index}`);
    }
  }

  #parseString(): string {
    this.#index += 1; // consume opening quote
    let result = "";
    for (;;) {
      const char = this.#text[this.#index];
      if (char === undefined) {
        this.#fail("unterminated string");
      }
      if (char === '"') {
        this.#index += 1;
        return result;
      }
      if (char === "\\") {
        this.#index += 1;
        result += this.#parseEscape();
        continue;
      }
      if (char.charCodeAt(0) < 0x20) {
        this.#fail(`unescaped control character at offset ${this.#index}`);
      }
      result += char;
      this.#index += 1;
    }
  }

  #parseEscape(): string {
    const escape = this.#text[this.#index];
    this.#index += 1;
    switch (escape) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.#text.slice(this.#index, this.#index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
          this.#fail(`invalid \\u escape at offset ${this.#index}`);
        }
        this.#index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.#fail(`invalid escape sequence at offset ${this.#index - 1}`);
    }
  }

  #parseLiteral(): JsonValue {
    if (this.#text.startsWith("true", this.#index)) {
      this.#index += 4;
      return true;
    }
    if (this.#text.startsWith("false", this.#index)) {
      this.#index += 5;
      return false;
    }
    if (this.#text.startsWith("null", this.#index)) {
      this.#index += 4;
      return null;
    }
    this.#fail(`invalid literal at offset ${this.#index}`);
  }

  #parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.#text.slice(this.#index),
    );
    if (match === null) {
      this.#fail(`invalid number at offset ${this.#index}`);
    }
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      this.#fail(`non-finite number at offset ${this.#index}`);
    }
    this.#index += match[0].length;
    return value;
  }
}

/** Parses strict, duplicate-key-rejecting JSON. Never throws. */
export function parseStrictJson(text: string): StrictJsonResult {
  try {
    return { ok: true, value: new StrictJsonParser(text).parse() };
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return {
      ok: false,
      code: "malformed-json",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** True for a JSON object (not `null`, not an array). */
export function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
