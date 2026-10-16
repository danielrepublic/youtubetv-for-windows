// Pure-logic unit suite for the issue #1 migration notice catalog entry.
//
// This suite asserts the BEHAVIOR of sidMigrationDialog: it must name both
// directories the user needs (the untouched legacy profile and the fresh
// SID-scoped one), must be bilingual, must state a re-login is required, and
// must offer exactly one acknowledgement button. It deliberately does not pin
// the full prose. The actual startup precedence (fallback wins over migration;
// the notice is invoked before the first session/window) is proven separately
// in test/electron/secure-host.test.mjs against the real entry.

import assert from "node:assert/strict";
import test from "node:test";

const { sidMigrationDialog } = await import("../../src/main/dialogs.ts");

// Synthetic, non-real paths. The SID segment is a fabricated S-1-5-21 identity
// so nothing here can be confused with a live machine.
const LEGACY_DIRECTORY =
  "C:\\ProgramData\\youtubetv-for-windows\\users\\Ada Lovelace#1\\profile";
const FRESH_DIRECTORY =
  "C:\\ProgramData\\youtubetv-for-windows\\users\\by-sid\\S-1-5-21-100-200-300-1001\\profile";

test("sidMigrationDialog names both the legacy and the fresh directory", () => {
  const content = sidMigrationDialog(LEGACY_DIRECTORY, FRESH_DIRECTORY);
  assert.ok(content.message.includes(LEGACY_DIRECTORY));
  assert.ok(content.message.includes(FRESH_DIRECTORY));
});

test("sidMigrationDialog is bilingual and requires a fresh sign-in", () => {
  const content = sidMigrationDialog(LEGACY_DIRECTORY, FRESH_DIRECTORY);
  assert.match(content.title, /[\u4e00-\u9fff]/);
  assert.match(content.title, /[A-Za-z]/);
  assert.match(content.message, /重新登入/);
  assert.match(content.message, /sign in again/i);
});

test("sidMigrationDialog offers exactly one acknowledgement button", () => {
  const content = sidMigrationDialog(LEGACY_DIRECTORY, FRESH_DIRECTORY);
  assert.deepEqual(content.buttons, ["確定 (OK)"]);
});

test("sidMigrationDialog is deterministic for the same directories", () => {
  assert.deepEqual(
    sidMigrationDialog(LEGACY_DIRECTORY, FRESH_DIRECTORY),
    sidMigrationDialog(LEGACY_DIRECTORY, FRESH_DIRECTORY),
  );
});
