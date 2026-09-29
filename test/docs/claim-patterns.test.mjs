// Owner-docs claim-pattern gate (plan checkbox 9, QA failure clause).
//
// Misleading positive claims fail the build wherever they appear, while the
// required negative disclosures must be present: the docs stay honest by
// construction, not by review. Lookbehinds keep "not affiliated" and
// "no official support" (the honest phrasing) from tripping the gate.

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

const DOCS = ["README.md", "docs/privacy.md", "docs/release-notes-template.md"];

function readDoc(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

// Positive claims the checkbox names (plus the affiliation/support shapes
// around them). Each must be absent from every doc.
const FORBIDDEN_PATTERNS = [
  /official YouTube app/i,
  /guaranteed 4K/i,
  /4K is guaranteed/i,
  /rollback available/i,
  /(?<!not )affiliated with (youtube|google)/i,
  /endorsed by (youtube|google)/i,
  /(?<!no )official support/i,
];

// Negative disclosures the checkbox requires. Each must be present wherever
// owners read risk posture.
const REQUIRED_NEGATIVES = [/not official/i, /no rollback/i, /no guarantee/i];
const NEGATIVE_SCOPE = [
  "README.md",
  "docs/privacy.md",
  "docs/release-notes-template.md",
];

test("no doc makes a misleading positive claim", () => {
  for (const relativePath of DOCS) {
    const text = readDoc(relativePath);
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(
        text,
        pattern,
        `${relativePath} makes a forbidden claim matching ${pattern}`,
      );
    }
  }
});

test("the required negative disclosures are present, not just permitted", () => {
  for (const relativePath of NEGATIVE_SCOPE) {
    const text = readDoc(relativePath);
    for (const pattern of REQUIRED_NEGATIVES) {
      assert.match(text, pattern, `${relativePath} must disclose ${pattern}`);
    }
  }
});

test("the device-spoofing risk is disclosed as a risk, never a feature", () => {
  const readme = readDoc("README.md");
  assert.match(readme, /device spoofing/i);
  assert.match(readme, /risk, not a feature/i);
});
