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

const { SUPPORT_RELEASE_URL } = await import("../../src/main/dialogs.ts");
const {
  PROFILE_DIRECTORY_NAME,
  USERS_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
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
  "### 已經安裝過：重新安裝、解除安裝或取消",
  "### SmartScreen 警告",
  "### 第一次啟動與全螢幕",
  "### 登入",
  "### 手機配對",
  "### 4K 播放條件",
  "### 發生問題時的處理",
  "### 換新版本",
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
  "### Already installed: reinstall, uninstall, or cancel",
  "### About the SmartScreen warning",
  "### First launch and fullscreen",
  "### Sign-in",
  "### Phone pairing",
  "### 4K playback",
  "### When something goes wrong",
  "### Getting a new version",
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

test("the documented profile path matches profile-path.ts", () => {
  // The programDataDir root, the per-Windows-user key level, and the profile
  // leaf, all derived from the resolver's own exported names.
  const documentedPath =
    `%PROGRAMDATA%\\${PROFILE_DIRECTORY_NAME}\\${USERS_DIRECTORY_NAME}` +
    `\\<key>\\${PROFILE_SUBDIRECTORY_NAME}`;
  for (const half of [zhHalf, enHalf]) {
    assert.ok(
      half.includes(documentedPath),
      `the README half must document the exact profile directory ${documentedPath}`,
    );
  }
});

test("the documented support URL matches dialogs.ts", () => {
  assert.equal(
    SUPPORT_RELEASE_URL,
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  );
  assert.ok(readme.includes(SUPPORT_RELEASE_URL));
});

// The install is machine-wide and elevating, and the data root is the
// machine-wide ProgramData tree. Every literal below is derived from the
// shipped sources (package.json's product name names the per-machine install
// directory; profile-path.ts exports the data-root directory names), so a
// regression in either one fails the docs instead of being documented around.
const MACHINE_INSTALL_ROOT = `C:\\Program Files\\${manifest.build.productName}`;
const MACHINE_DATA_ROOT = `C:\\ProgramData\\${PROFILE_DIRECTORY_NAME}`;
const ENV_DATA_ROOT = `%PROGRAMDATA%\\${PROFILE_DIRECTORY_NAME}`;
const PER_USER_ROOT = `${ENV_DATA_ROOT}\\${USERS_DIRECTORY_NAME}\\<key>`;

test("both halves name the install root, the UAC step, and the data root", () => {
  for (const half of [zhHalf, enHalf]) {
    for (const [description, literal] of [
      ["machine-wide install root", MACHINE_INSTALL_ROOT],
      ["machine-wide data root", MACHINE_DATA_ROOT],
      ["data root in environment form", ENV_DATA_ROOT],
      ["per-user subdirectory", PER_USER_ROOT],
    ]) {
      assert.ok(
        half.includes(literal),
        `each README half must document the ${description} ${literal}`,
      );
    }
    assert.ok(
      half.includes("UAC"),
      "each README half must name the elevation prompt, because installing needs administrator rights",
    );
  }
});

test("both halves state that uninstall removes the whole machine-wide data root", () => {
  for (const half of [zhHalf, enHalf]) {
    assert.ok(
      half
        .split("\n")
        .some(
          (line) =>
            line.includes(MACHINE_DATA_ROOT) &&
            /uninstall|解除安裝/i.test(line),
        ),
      "one line per half must tie the data root to the uninstall, so the removal rule is findable",
    );
  }
});

test("every shipped already-installed chooser string is quoted in both halves", () => {
  // The chooser wording is the app-owned language contract: it is read from
  // build/nsis.include rather than restated here, so a rename in the installer
  // breaks this suite instead of leaving the README quoting stale buttons.
  // Both halves carry every segment, because the page itself shows both
  // languages regardless of which half the reader is on.
  const nsisInclude = readDoc("build/nsis.include");
  const CHOOSER_DEFINES = [
    "YTVW_CHOOSER_TITLE",
    "YTVW_CHOOSER_REINSTALL",
    "YTVW_CHOOSER_UNINSTALL",
    "YTVW_CHOOSER_CANCEL",
  ];
  for (const name of CHOOSER_DEFINES) {
    const match = new RegExp(`!define\\s+${name}\\s+"([^"]*)"`).exec(
      nsisInclude,
    );
    assert.ok(match !== null, `build/nsis.include must define ${name}`);
    const segments = match[1]
      .replaceAll("$\\r$\\n", "\n")
      .split("\n")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    assert.ok(
      segments.length > 0,
      `${name} must expand to at least one non-empty line`,
    );
    for (const half of [zhHalf, enHalf]) {
      for (const segment of segments) {
        assert.ok(
          half.includes(segment),
          `each README half must quote the shipped ${name} text ${segment}`,
        );
      }
    }
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

test("privacy and release notes carry their required markers", () => {
  const privacy = readDoc("docs/privacy.md");
  assert.ok(privacy.includes("## 繁體中文"));
  assert.ok(privacy.includes("## English"));
  assert.ok(privacy.includes("diagnostics\\ENABLED"));
  const notes = readDoc("docs/release-notes-template.md");
  assert.ok(notes.includes("SHA-256"));
  assert.ok(notes.includes("do not delete"));
});
