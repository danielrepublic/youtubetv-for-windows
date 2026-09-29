// Owner-docs link checker (plan checkbox 9, QA happy clause).
//
// Every doc must point at the configured repository Release path, and no doc
// may point at a wrong repository or an insecure URL. The canonical URL is
// imported from dialogs.ts, so a repository move fails the suite instead of
// silently documenting a dead link.

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

const { SUPPORT_RELEASE_URL } = await import("../../src/main/dialogs.ts");

const DOCS = ["README.md", "docs/privacy.md", "docs/release-notes-template.md"];

const REPOSITORY_PREFIX =
  "https://github.com/danielrepublic/youtubetv-for-windows";
const ALLOWED_HOSTS = new Set(["github.com", "www.youtube.com", "youtube.com"]);

function readDoc(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function extractUrls(text) {
  const found = text.match(/https?:\/\/[^\s)"'`\]>]+/g) ?? [];
  return found.map((url) => url.replace(/[.,;:!?]+$/, ""));
}

test("every owner doc points at the configured Release URL", () => {
  assert.equal(
    SUPPORT_RELEASE_URL,
    `${REPOSITORY_PREFIX}/releases/latest`,
    "the suite assumes the latest-release path from dialogs.ts",
  );
  for (const relativePath of DOCS) {
    assert.ok(
      readDoc(relativePath).includes(SUPPORT_RELEASE_URL),
      `${relativePath} must link ${SUPPORT_RELEASE_URL}`,
    );
  }
});

test("no doc links a wrong repository or an insecure URL", () => {
  for (const relativePath of DOCS) {
    for (const url of extractUrls(readDoc(relativePath))) {
      assert.ok(
        url.startsWith("https://"),
        `${relativePath} links insecure ${url}`,
      );
      const host = new URL(url).host.toLowerCase();
      assert.ok(
        ALLOWED_HOSTS.has(host),
        `${relativePath} links an unexpected host: ${url}`,
      );
      if (host === "github.com") {
        assert.ok(
          url.startsWith(REPOSITORY_PREFIX),
          `${relativePath} links a wrong repository URL: ${url}`,
        );
      }
    }
  }
});
