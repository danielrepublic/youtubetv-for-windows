// Owner-docs locale contract (plan checkbox 9).
//
// Every required section must exist in BOTH language variants, and every
// code-derived fact (installer name, profile path, release URL, dialog
// wording) must appear verbatim. Expectations come from the checkbox and
// from the sources themselves, never from the prose under test: a missing
// heading or a drifted fact fails the build.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const manifest = require(path.join(repositoryRoot, "package.json"));

const { SUPPORT_RELEASE_URL, updateFailureDialog, updateRepairDialog } =
  await import("../../src/main/dialogs.ts");
const {
  PROFILE_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
  UPDATE_DIRECTORY_NAME,
  UPDATE_STATUS_DIRECTORY_NAME,
} = await import("../../src/main/profile-path.ts");

function readDoc(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

const readme = readDoc("README.md");
const halves = readme.split("\n## English\n");
assert.equal(
  halves.length,
  2,
  "the README must split into exactly one zhTW half and one English half",
);
const [zhHalf, enHalf] = halves;

// Headings below must match the README text exactly; each one names a
// disclosure the checkbox enumerates, so deleting one fails the suite.
const REQUIRED_ZH_HEADINGS = [
  "### 這個程式是什麼",
  "### 非官方聲明與風險",
  "### 系統需求",
  "### 下載：只要認一個安裝檔",
  "### 安裝",
  "### SmartScreen 警告",
  "### 第一次啟動與全螢幕",
  "### 登入",
  "### 手機配對",
  "### 4K 播放條件",
  "### 更新",
  "### 發生問題時的處理",
  "### 手動下載修復",
  "### 解除安裝會刪掉什麼",
  "### 你的資料存在哪裡",
  "### 支援",
];

const REQUIRED_EN_HEADINGS = [
  "### What this is",
  "### Unofficial status and risks",
  "### Requirements",
  "### Download: trust exactly one installer",
  "### Install",
  "### About the SmartScreen warning",
  "### First launch and fullscreen",
  "### Sign-in",
  "### Phone pairing",
  "### 4K playback",
  "### Updates",
  "### When something goes wrong",
  "### Manual-download recovery",
  "### What uninstall removes",
  "### Where your data lives",
  "### Support",
];

test("every required Traditional Chinese heading exists in the zhTW half", () => {
  assert.ok(zhHalf.includes("## 繁體中文"));
  for (const heading of REQUIRED_ZH_HEADINGS) {
    assert.ok(zhHalf.includes(heading), `the zhTW half is missing ${heading}`);
  }
});

test("every required English heading exists in the English half", () => {
  for (const heading of REQUIRED_EN_HEADINGS) {
    assert.ok(
      enHalf.includes(heading),
      `the English half is missing ${heading}`,
    );
  }
});

test("neither language half is empty or bleeds into the other", () => {
  assert.ok(!zhHalf.includes("### Sign-in"));
  assert.ok(!enHalf.includes("### 登入"));
  assert.ok(zhHalf.length > 1000);
  assert.ok(enHalf.length > 1000);
});

test("the documented installer name matches package.json", () => {
  const expected = `${manifest.build.productName}-${manifest.version}-x64.exe`;
  assert.ok(
    readme.includes(expected),
    `the README must name the real installer ${expected}`,
  );
  assert.ok(readme.includes("youtubetv-for-windows-<版本>-x64.exe"));
  assert.ok(readme.includes("youtubetv-for-windows-<version>-x64.exe"));
});

test("the documented profile and update paths match profile-path.ts", () => {
  const profileSuffix = `${PROFILE_DIRECTORY_NAME}\\${PROFILE_SUBDIRECTORY_NAME}`;
  assert.ok(
    readme.includes(`%LOCALAPPDATA%\\${profileSuffix}`),
    "the README must document the exact profile directory",
  );
  assert.ok(
    readme.includes(UPDATE_DIRECTORY_NAME),
    "the README must name the pending-update directory",
  );
  assert.ok(
    readme.includes(UPDATE_STATUS_DIRECTORY_NAME),
    "the README must name the update-status directory",
  );
});

test("the documented recovery wording matches dialogs.ts verbatim", () => {
  assert.equal(
    SUPPORT_RELEASE_URL,
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  );
  assert.ok(readme.includes(SUPPORT_RELEASE_URL));
  // Every update dialog body the code can render must be quoted in EACH
  // language half: dialogs.ts is the single source of truth, so a body
  // deleted from either half fails the build instead of silently breaking
  // the README's word-for-word claim.
  const requiredDialogs = [
    ...["download-or-verify-failed", "installer-launch-failed"].map((kind) => ({
      label: kind,
      content: updateFailureDialog(kind),
    })),
    ...["missing", "invalid", "unconfirmed"].map((reason) => ({
      label: `repair-${reason}`,
      content: updateRepairDialog(reason),
    })),
  ];
  assert.equal(requiredDialogs.length, 5);
  for (const { label, content } of requiredDialogs) {
    assert.ok(zhHalf.includes(content.title), `zhTW half is missing ${label}`);
    assert.ok(
      enHalf.includes(content.title),
      `English half is missing ${label}`,
    );
    assert.ok(
      zhHalf.includes(content.message),
      `the zhTW half must quote the ${label} dialog body verbatim`,
    );
    assert.ok(
      enHalf.includes(content.message),
      `the English half must quote the ${label} dialog body verbatim`,
    );
  }
});

test("Traditional Chinese documents contain no Simplified-only characters", () => {
  // High-precision subset: each listed character is Simplified-only and never
  // valid Traditional Chinese, so any hit is a real defect. Limitation: this
  // is a curated list, not an exhaustive Unihan comparison; absence proves
  // freedom from these characters only.
  const SIMPLIFIED_ONLY = [
    ["动", "動"],
    ["发", "發"],
    ["语", "語"],
    ["说", "說"],
    ["国", "國"],
    ["时", "時"],
    ["实", "實"],
    ["认", "認"],
    ["让", "讓"],
    ["过", "過"],
    ["还", "還"],
    ["远", "遠"],
    ["运", "運"],
    ["设", "設"],
    ["测", "測"],
    ["试", "試"],
    ["证", "證"],
    ["网", "網"],
    ["页", "頁"],
    ["确", "確"],
    ["读", "讀"],
    ["数", "數"],
    ["据", "據"],
    ["个", "個"],
    ["与", "與"],
    ["现", "現"],
    ["软", "軟"],
    ["无", "無"],
    ["为", "為"],
  ];
  for (const relativePath of [
    "README.md",
    "docs/privacy.md",
    "docs/release-certification.md",
    "docs/release-notes-template.md",
  ]) {
    const text = readDoc(relativePath);
    for (const [simplified, traditional] of SIMPLIFIED_ONLY) {
      assert.ok(
        !text.includes(simplified),
        `${relativePath} uses Simplified ${simplified}; use ${traditional}`,
      );
    }
  }
});

test("privacy, release-notes, and certification carry their required markers", () => {
  const privacy = readDoc("docs/privacy.md");
  assert.ok(privacy.includes("## 繁體中文"));
  assert.ok(privacy.includes("## English"));
  assert.ok(privacy.includes("diagnostics\\ENABLED"));
  const notes = readDoc("docs/release-notes-template.md");
  assert.ok(notes.includes("SHA-256"));
  assert.ok(notes.includes("do not delete"));
  const certification = readDoc("docs/release-certification.md");
  assert.ok(certification.includes("awaiting-maintainer-evidence"));
  assert.ok(certification.includes("DO NOT PUBLISH"));
  assert.ok(certification.includes("Stats-for-nerds"));
  assert.ok(certification.includes("25 Mbps"));
  assert.ok(certification.includes("phone pairing"));
  assert.ok(certification.includes("sign-in persists"));
});
