// Owner-docs data-location gate (Final-Wave finding: a false privacy claim).
//
// The docs used to carry an absolute negative in both language halves, in both
// owner-facing documents: the app "never writes to %APPDATA% or %LOCALAPPDATA%"
// and "nothing from this app is written inside your user profile folder". That
// claim was false, and the existing claim-pattern lists were blind to the
// subject, which is how it reached HEAD with a fully green doc suite.
//
// The app has TWO reachable write locations beyond the normal data root, and
// both are named here so a reader can find them:
//   1. a blank or missing PROGRAMDATA resolves the data root to
//      app.getPath("appData"), which is %APPDATA% on Windows;
//   2. an unusable data root falls back to mkdtemp under os.tmpdir(), which is
//      %LOCALAPPDATA%\Temp on Windows, and the app shows that directory on
//      screen.
// So this gate asserts the claim is SCOPED (both exceptions named, in both
// languages) and refuses the absolute negative outright. Expectations about the
// path literals are derived from profile-path.ts, so a rename in the shipped
// source fails the docs instead of being documented around.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const { PROFILE_DIRECTORY_NAME, USERS_DIRECTORY_NAME } =
  await import("../../src/main/profile-path.ts");

const DOCS = ["README.md", "docs/privacy.md"];

function readDoc(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function splitHalves(relativePath) {
  const halves = readDoc(relativePath).split("\n## English\n");
  assert.equal(
    halves.length,
    2,
    `${relativePath} must split into exactly one zhTW half and one English half`,
  );
  return { zh: halves[0], en: halves[1] };
}

// The three data locations every language half has to name. Deriving them from
// the shipped constants is the same move locale-content.test.mjs makes: the
// directory names come from the resolver, the environment roots are Windows
// facts, and `<key>` is the per-user segment the resolver builds.
const NORMAL_DATA_ROOT = `%PROGRAMDATA%\\${PROFILE_DIRECTORY_NAME}`;
const APPDATA_FALLBACK_ROOT = `%APPDATA%\\${PROFILE_DIRECTORY_NAME}\\${USERS_DIRECTORY_NAME}\\<key>`;
const TEMP_FALLBACK_ROOT = "%LOCALAPPDATA%\\Temp";
const TEMP_FALLBACK_PREFIX = `${PROFILE_DIRECTORY_NAME}-profile-`;

const REQUIRED_LOCATIONS = [
  ["the normal machine-wide data root", NORMAL_DATA_ROOT],
  ["the blank-PROGRAMDATA fallback data root", APPDATA_FALLBACK_ROOT],
  ["the temporary-profile fallback root", TEMP_FALLBACK_ROOT],
  ["the temporary-profile directory name", TEMP_FALLBACK_PREFIX],
];

// Unscoped absolute negatives about %APPDATA% / %LOCALAPPDATA%, in both
// languages, including the "no longer writes there" sub-claim about the folder
// older builds left behind. Every Chinese pattern keys on the exact denial
// construction, never on a bare 寫入, which the honest condition statements also
// use, so scoped wording stays writable. The English patterns key on the
// subject phrase "nothing from this app" and on a bare "never writes to
// %APPDATA%": "on a normal start" and "normally nothing new is written" carry
// neither, so an honest rewrite is not blocked.
const FORBIDDEN_ABSOLUTE_NEGATIVES = [
  /never writes? to\s*`%(?:LOCAL)?APPDATA%/i,
  /nothing from this app (?:is |lands |lives |ever |ends up )?(?:in|inside|into|to|under|written|stored|saved|landed|goes|kept)/i,
  /no longer writes (?:there|into it)/i,
  /不會(?:再)?(?:被)?寫(?:入|進)\s*`%(?:LOCAL)?APPDATA%/,
  /不會有這個程式的(?:任何)?資料/,
  /不會再寫(?:入|進)這個目錄/,
];

test("no owner doc makes an unscoped claim about where the app writes", () => {
  for (const relativePath of DOCS) {
    const text = readDoc(relativePath);
    for (const pattern of FORBIDDEN_ABSOLUTE_NEGATIVES) {
      assert.doesNotMatch(
        text,
        pattern,
        `${relativePath} makes a forbidden data-location claim matching ${pattern}`,
      );
    }
  }
});

test("every language half of every owner doc names all three data locations", () => {
  for (const relativePath of DOCS) {
    const halves = splitHalves(relativePath);
    for (const [language, text] of Object.entries(halves)) {
      for (const [description, literal] of REQUIRED_LOCATIONS) {
        assert.ok(
          text.includes(literal),
          `the ${language} half of ${relativePath} must document ${description} as ${literal}`,
        );
      }
    }
  }
});

// The bilingual halves must be at the same strength: one list of required
// disclosures, applied to both, is the parity check. A half that quietly drops
// an exception is a false claim in the language the reviewer did not read.
test("the two language halves carry the same data-location disclosures", () => {
  for (const relativePath of DOCS) {
    const { zh, en } = splitHalves(relativePath);
    for (const [description, literal] of REQUIRED_LOCATIONS) {
      assert.equal(
        zh.includes(literal),
        en.includes(literal),
        `${relativePath} discloses ${description} in only one language half`,
      );
    }
    assert.ok(
      /例外|blank|fallback|temporary|temp/i.test(zh) &&
        /exception|blank|fallback|temporary|temp/i.test(en),
      `${relativePath} must name the exceptions as exceptions in both halves`,
    );
  }
});

test("both halves say uninstall keeps the fallback locations", () => {
  const UNINSTALL = { zh: /解除安裝/, en: /uninstall/i };
  const SAFE_TO_DELETE = { zh: /安全的|安全/, en: /safe/i };
  for (const relativePath of DOCS) {
    const halves = splitHalves(relativePath);
    for (const [language, text] of Object.entries(halves)) {
      for (const [description, pattern] of [
        ["uninstall", UNINSTALL[language]],
        ["deleting by hand being safe", SAFE_TO_DELETE[language]],
      ]) {
        assert.match(
          text,
          pattern,
          `the ${language} half of ${relativePath} must say ${description}`,
        );
      }
      assert.ok(
        text.includes(TEMP_FALLBACK_ROOT),
        `the ${language} half of ${relativePath} must name the temporary fallback root`,
      );
    }
  }
});
