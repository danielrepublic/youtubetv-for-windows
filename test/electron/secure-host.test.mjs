// Node-side secure-host suite: fixed identity, no-override policy, window
// security validation, and preload packaging. No Electron spawn here; the
// spawned integration scenarios live in secure-host-integration.test.mjs.

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
const srcDirectory = path.join(repositoryRoot, "src");

const { FIXED_USER_AGENT, assertIdentityPolicy } =
  await import("../../src/main/user-agent.ts");
const { buildWindowOptions, resolvePreloadPath, validateWebPreferences } =
  await import("../../src/main/window.ts");

const EXPECTED_USER_AGENT =
  "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)";

function listSourceFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  };
  walk(srcDirectory);
  return files.sort();
}

test("the fixed user agent is the exact verified PS4 string", () => {
  assert.equal(FIXED_USER_AGENT, EXPECTED_USER_AGENT);
});

test("assertIdentityPolicy accepts only the fixed string", () => {
  assertIdentityPolicy(FIXED_USER_AGENT);
  assert.throws(() => assertIdentityPolicy("evil"), /rejected/);
  assert.throws(() => assertIdentityPolicy(""), /rejected/);
  assert.throws(() => assertIdentityPolicy(`${FIXED_USER_AGENT} `), /rejected/);
});

test("no override path exists anywhere in production source", () => {
  const files = listSourceFiles();
  assert.ok(files.length > 0, "expected source files under src/");
  const forbidden = [
    /process\.env/,
    /process\.argv/,
    /commandLine/,
    /getenv/,
    /YOUTUBE_TV_USER_AGENT/,
    /--user-agent/,
    /readFileSync/,
    /localStorage/,
    /sessionStorage/,
    /exposeInMainWorld/,
    /ipcRenderer/,
    /ipcMain/,
  ];
  const violations = [];
  for (const file of files) {
    const contents = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(contents)) {
        violations.push(
          `${path.relative(repositoryRoot, file)} matches ${pattern}`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the fixed identity string appears only in user-agent.ts", () => {
  const offenders = [];
  for (const file of listSourceFiles()) {
    const contents = fs.readFileSync(file, "utf8");
    if (
      contents.includes("Mozilla/5.0") &&
      path.relative(srcDirectory, file) !== path.join("main", "user-agent.ts")
    ) {
      offenders.push(path.relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
  const identitySource = fs.readFileSync(
    path.join(srcDirectory, "main", "user-agent.ts"),
    "utf8",
  );
  assert.ok(identitySource.includes(EXPECTED_USER_AGENT));
});

test("validateWebPreferences rejects every insecure configuration", () => {
  const valid = {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    partition: "persist:youtubetv",
    preload: resolvePreloadPath(repositoryRoot),
    spellcheck: false,
  };
  validateWebPreferences(valid);
  assert.throws(
    () => validateWebPreferences({ ...valid, nodeIntegration: true }),
    /nodeIntegration/,
  );
  assert.throws(
    () => validateWebPreferences({ ...valid, contextIsolation: false }),
    /contextIsolation/,
  );
  assert.throws(
    () => validateWebPreferences({ ...valid, sandbox: false }),
    /sandbox/,
  );
  assert.throws(
    () => validateWebPreferences({ ...valid, partition: "persist:evil" }),
    /partition/,
  );
  assert.throws(
    () => validateWebPreferences({ ...valid, preload: "" }),
    /preload/,
  );
});

test("buildWindowOptions returns the exact secure fullscreen configuration", () => {
  const expectedPreload = path.join(
    repositoryRoot,
    "dist",
    "preload",
    "preload.js",
  );
  assert.equal(resolvePreloadPath(repositoryRoot), expectedPreload);
  assert.deepEqual(buildWindowOptions(repositoryRoot), {
    fullscreen: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: "persist:youtubetv",
      preload: expectedPreload,
      spellcheck: false,
    },
  });
});

test("the preload exposes no privileged API", () => {
  const contents = fs.readFileSync(
    path.join(srcDirectory, "preload.ts"),
    "utf8",
  );
  assert.match(contents, /__youtubeTvHost/);
  assert.match(contents, /Object\.freeze/);
  const codeOnly = contents
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const pattern of [
    /\brequire\s*\(/,
    /\bprocess\b/,
    /contextBridge/,
    /ipc/,
    /\bimport\b/,
    /\bexport\b/,
  ]) {
    assert.doesNotMatch(codeOnly, pattern);
  }
});

test("the preload is emitted as CommonJS behind the marker", () => {
  const preloadEntry = path.join(
    repositoryRoot,
    "dist",
    "preload",
    "preload.js",
  );
  assert.ok(
    fs.existsSync(preloadEntry),
    "dist/preload/preload.js is missing: the pretest:electron build hook must run first",
  );
  const emitted = fs.readFileSync(preloadEntry, "utf8");
  assert.doesNotMatch(emitted, /^export\s/m);
  assert.doesNotMatch(emitted, /^import\s/m);
  const marker = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "dist", "preload", "package.json"),
      "utf8",
    ),
  );
  assert.equal(marker.type, "commonjs");
});

test("the pretest:electron hook rebuilds dist before the electron chain", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const manifest = require(path.join(repositoryRoot, "package.json"));
  assert.equal(manifest.scripts["pretest:electron"], "npm run build");
});
