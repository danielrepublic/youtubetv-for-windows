// The launch-argument allowlist contract.
//
// `src/main/update/launch-arguments.ts` is the ONE sanctioned argument read
// in `src/` (pinned separately by test/electron/secure-host.test.mjs). This
// suite proves the parser itself cannot act as a general override channel:
// only `--update-nonce=<value>` is ever returned, the first occurrence wins,
// a malformed first occurrence fails closed, and every other argument shape
// (including lookalike flags) is dropped.

import assert from "node:assert/strict";
import test from "node:test";

const {
  UPDATE_NONCE_FLAG,
  isValidUpdateNonce,
  parseUpdateNonce,
  readLaunchUpdateNonce,
} = await import("../../src/main/update/launch-arguments.ts");

const VALID_NONCE = "0123456789abcdef0123456789abcdef";

test("the flag literal is exactly the documented one", () => {
  assert.equal(UPDATE_NONCE_FLAG, "--update-nonce");
});

test("the exact nonce flag parses", () => {
  assert.equal(
    parseUpdateNonce([`--update-nonce=${VALID_NONCE}`]),
    VALID_NONCE,
  );
  assert.equal(
    parseUpdateNonce(["/S", `--update-nonce=${VALID_NONCE}`]),
    VALID_NONCE,
  );
});

test("no nonce flag means no nonce", () => {
  assert.equal(parseUpdateNonce([]), null);
  assert.equal(parseUpdateNonce(["/S", "--updated", "https://x/"]), null);
});

test("every other argument is ignored, never interpreted", () => {
  const args = [
    "--user-agent=evil",
    "--update-nonce-evil=deadbeef",
    "http://example.com/",
    "/D=C:\\evil",
    "-update-nonce=deadbeef",
    "update-nonce=deadbeef",
    `--update-nonce=${VALID_NONCE}`,
  ];
  assert.equal(parseUpdateNonce(args), VALID_NONCE);
});

test("the FIRST occurrence wins and cannot be overridden by a duplicate", () => {
  assert.equal(
    parseUpdateNonce([
      "--update-nonce=firstvalue",
      "--update-nonce=secondvalue",
    ]),
    "firstvalue",
  );
});

test("a malformed first occurrence fails closed", () => {
  for (const bad of [
    "--update-nonce=",
    "--update-nonce=../escape",
    "--update-nonce=a/b",
    "--update-nonce=a\\b",
    "--update-nonce=a b",
    '--update-nonce=a"b',
    "--update-nonce=a<b>c",
    `--update-nonce=${"a".repeat(129)}`,
  ]) {
    assert.equal(parseUpdateNonce([bad]), null, `must reject ${bad}`);
    assert.equal(
      parseUpdateNonce([bad, `--update-nonce=${VALID_NONCE}`]),
      null,
      `a later valid duplicate must not rescue ${bad}`,
    );
  }
});

test("a bare flag is not a value and is skipped", () => {
  assert.equal(parseUpdateNonce(["--update-nonce"]), null);
  assert.equal(
    parseUpdateNonce(["--update-nonce", `--update-nonce=${VALID_NONCE}`]),
    VALID_NONCE,
  );
});

test("the value alphabet is bounded and path-safe", () => {
  assert.equal(isValidUpdateNonce(VALID_NONCE), true);
  assert.equal(isValidUpdateNonce("A-Za-z0-9-Dash"), true);
  assert.equal(isValidUpdateNonce("a".repeat(128)), true);
  assert.equal(isValidUpdateNonce(""), false);
  assert.equal(isValidUpdateNonce("a".repeat(129)), false);
  for (const unsafe of ["..", "a.b", "a/b", "a\\b", "a:b", "a%b", "a$b"]) {
    assert.equal(isValidUpdateNonce(unsafe), false, `must reject ${unsafe}`);
  }
});

test("the live process vector contains no nonce in this test runner", () => {
  // The test runner's own arguments must never be mistaken for a handoff
  // nonce, and the reader must be total.
  assert.equal(readLaunchUpdateNonce(), null);
});
