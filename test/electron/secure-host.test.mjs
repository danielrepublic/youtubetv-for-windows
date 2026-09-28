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
  // NOTE: process.env is intentionally absent from this list: it is handled
  // by the dedicated environment-read test below, which bans it everywhere
  // except the single LOCALAPPDATA read that fixes the profile convention.
  // NOTE: readFileSync is intentionally absent too: it is handled by the
  // host-surface file-read test below, because the updater domain owns
  // legitimate file I/O (lock + manifest) under src/main/update/.
  //
  // process.argv has exactly ONE sanctioned reader: the nonce allowlist
  // module that parses the NSIS relaunch handoff (--update-nonce only). The
  // separate test below proves the allowlist list itself is exactly one
  // file, that the parser ignores everything else, and that no other
  // argument literal exists in that module. Every other src/ file remains
  // banned outright.
  const launchArgumentsFile = path.join(
    srcDirectory,
    "main",
    "update",
    "launch-arguments.ts",
  );
  const forbidden = [
    {
      pattern: /process\.argv/,
      allowlist: new Set([launchArgumentsFile]),
    },
    { pattern: /commandLine/ },
    { pattern: /getenv/ },
    { pattern: /YOUTUBE_TV_USER_AGENT/ },
    { pattern: /--user-agent/ },
    { pattern: /localStorage/ },
    { pattern: /sessionStorage/ },
    { pattern: /exposeInMainWorld/ },
    { pattern: /ipcRenderer/ },
    { pattern: /ipcMain/ },
  ];
  const violations = [];
  for (const file of files) {
    const contents = fs.readFileSync(file, "utf8");
    for (const { pattern, allowlist } of forbidden) {
      if (allowlist !== undefined && allowlist.has(file)) {
        continue;
      }
      if (pattern.test(contents)) {
        violations.push(
          `${path.relative(repositoryRoot, file)} matches ${pattern}`,
        );
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("the only argument read is the narrow update-nonce parser", async () => {
  const launchArgumentsFile = path.join(
    srcDirectory,
    "main",
    "update",
    "launch-arguments.ts",
  );
  const readers = listSourceFiles().filter((file) =>
    /process\.argv/.test(fs.readFileSync(file, "utf8")),
  );
  assert.deepEqual(
    readers,
    [launchArgumentsFile],
    "exactly one src/ file may read the process argument vector",
  );

  const { UPDATE_NONCE_FLAG, parseUpdateNonce, readLaunchUpdateNonce } =
    await import("../../src/main/update/launch-arguments.ts");
  assert.equal(UPDATE_NONCE_FLAG, "--update-nonce");
  // Only the nonce flag is honored...
  assert.equal(parseUpdateNonce(["--update-nonce=abc-DEF-123"]), "abc-DEF-123");
  // ...and every override-shaped argument is dropped.
  for (const argumentVector of [
    ["--user-agent=evil"],
    ["--url=https://evil.example/"],
    ["--target-url=https://evil.example/"],
    ["--profile=C:\\evil"],
    ["/D=C:\\evil"],
    ["--diagnostics"],
    ["--update-nonce-evil=deadbeef"],
  ]) {
    assert.equal(parseUpdateNonce(argumentVector), null);
  }
  // The ambient vector of this process carries no nonce.
  assert.equal(readLaunchUpdateNonce(), null);

  // Executable code in the allowlisted module contains exactly one
  // double-dash literal: the nonce flag. No second hidden switch can exist.
  const codeOnly = fs
    .readFileSync(launchArgumentsFile, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    })
    .join("\n");
  const flagLiterals = codeOnly.match(/--[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  assert.deepEqual([...new Set(flagLiterals)], ["--update-nonce"]);
});

test("only the updater domain reads files, and it cannot steer identity", () => {
  // Config-file-driven identity overrides would hide behind file reads, so
  // readFileSync is banned on the host surface (every src file outside
  // src/main/update/). The updater domain is exempt — its lock and manifest
  // handling is file I/O by design — but it must never reference the
  // identity partition or the profile session-data path, so its files
  // cannot steer identity storage even though they can read the disk.
  const updateSegment = path.join("src", "main", "update") + path.sep;
  const hostViolations = [];
  const steeringViolations = [];
  for (const file of listSourceFiles()) {
    const relative = path.relative(repositoryRoot, file);
    const contents = fs.readFileSync(file, "utf8");
    if (relative.startsWith(updateSegment)) {
      for (const pattern of [/persist:youtubetv/, /sessionData/]) {
        if (pattern.test(contents)) {
          steeringViolations.push(`${relative} matches ${pattern}`);
        }
      }
    } else if (/readFileSync/.test(contents)) {
      hostViolations.push(relative);
    }
  }
  assert.deepEqual(hostViolations, []);
  assert.deepEqual(steeringViolations, []);
});

test("the only environment read is the profile-path LOCALAPPDATA convention", () => {
  const profilePathFile = path.join(srcDirectory, "main", "profile-path.ts");
  const violations = [];
  for (const file of listSourceFiles()) {
    const relative = path.relative(repositoryRoot, file);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/process\.env/.test(line)) {
        return;
      }
      const isProfilePath = file === profilePathFile;
      const isSanctionedRead =
        isProfilePath && /process\.env\.LOCALAPPDATA\b/.test(line);
      if (!isSanctionedRead) {
        violations.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
  // The convention itself is pinned: version-independent per-user path
  // outside any install directory, with no version segment.
  const convention = fs.readFileSync(profilePathFile, "utf8");
  assert.match(convention, /%LOCALAPPDATA%\\youtubetv-for-windows\\profile/);
  assert.match(convention, /NO version/);
  assert.match(convention, /app\.setPath\("sessionData"/);
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
