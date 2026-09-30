// Node-side secure-host suite: fixed identity, no-override policy, window
// security validation, and preload packaging. No Electron spawn here; the
// spawned integration scenarios live in secure-host-integration.test.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { IDENTITY_PARTITION } = await import("../../src/main/session.ts");
const {
  PROFILE_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
  SESSION_DATA_PATH_NAME,
  USERS_DIRECTORY_NAME,
  USER_DATA_PATH_NAME,
  USER_DATA_SUBDIRECTORY_NAME,
} = await import("../../src/main/profile-path.ts");

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
  // except the two sanctioned profile-location reads (PROGRAMDATA and
  // USERPROFILE) that fix the per-user data layout.
  // NOTE: readFileSync is intentionally absent too: it is handled by the
  // host-surface file-read test below.
  const forbidden = [
    {
      pattern: /process\.argv/,
      allowlist: new Set(),
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

test("the process argument vector has no production readers", () => {
  const readers = listSourceFiles().filter((file) =>
    /process\.argv/.test(fs.readFileSync(file, "utf8")),
  );
  assert.deepEqual(readers, []);
});

test("host file reads cannot steer identity", () => {
  // Config-file-driven identity overrides would hide behind file reads, so
  // readFileSync is banned throughout the production source.
  const hostViolations = [];
  for (const file of listSourceFiles()) {
    const relative = path.relative(repositoryRoot, file);
    const contents = fs.readFileSync(file, "utf8");
    if (/readFileSync/.test(contents)) {
      hostViolations.push(relative);
    }
  }
  assert.deepEqual(hostViolations, []);
});

test("the only environment reads are the profile-path PROGRAMDATA and USERPROFILE convention", () => {
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
        isProfilePath &&
        /process\.env\.(?:PROGRAMDATA|USERPROFILE)\b/.test(line);
      if (!isSanctionedRead) {
        violations.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
  // The convention itself is pinned: a per-machine root under PROGRAMDATA, a
  // per-Windows-user key segment, no version segment, and BOTH Electron data
  // paths redirected before the first session access.
  const convention = fs.readFileSync(profilePathFile, "utf8");
  assert.match(
    convention,
    /%PROGRAMDATA%\\youtubetv-for-windows\\users\\<key>\\profile/,
  );
  assert.match(convention, /NO version/);
  assert.match(convention, /app\.setPath\("sessionData"/);
  assert.match(convention, /app\.setPath\("userData"/);
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

async function waitForEvent(recorder, event, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!recorder.events.includes(event)) {
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return true;
}

test("the entry redirects both data paths before ready, the first session, and the first window", async (t) => {
  // The ACTUAL-ORDER contract, not "setPath was called". The two hazards are
  // different and only the earlier one was broken: Chromium snapshots the
  // current userData value when each service child is spawned, and the GPU and
  // network-service children were already up on Electron's compiled-in roaming
  // default before a redirect that ran after `await app.whenReady()`. Their
  // graphics caches then landed in %APPDATA%\<product>, a tree the
  // uninstaller does not own. So the observable that must hold is
  //
  //   setPath(userData) < ready < first session < first window
  //
  // with the redirect already complete while the ready gate is still shut.
  const base = path.join(
    os.tmpdir(),
    `ytvw-startup-order-${process.pid}-${Date.now()}`,
  );
  const previous = {
    programData: process.env.PROGRAMDATA,
    userProfile: process.env.USERPROFILE,
  };
  // Hermetic data root: the production adapter reads PROGRAMDATA/USERPROFILE,
  // so both are aimed at a throwaway tree. Nothing outside it is created, and
  // the roaming default is never a write target for this test.
  process.env.PROGRAMDATA = path.join(base, "ProgramData");
  process.env.USERPROFILE = path.join(base, "Users", "probe-user");
  let releaseReady;
  const readyPromise = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const recorder = { events: [], readyPromise };
  globalThis.__ytvwStartupOrder = recorder;
  t.after(() => {
    delete globalThis.__ytvwStartupOrder;
    for (const [name, value] of [
      ["PROGRAMDATA", previous.programData],
      ["USERPROFILE", previous.userProfile],
    ]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  const fakeElectron = pathToFileURL(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fake-electron.mjs",
    ),
  ).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") {
        return { url: fakeElectron, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });

  // Importing evaluates the entry's module top level. Nothing in it awaits
  // before the redirect, so both setPath calls must already be on the record
  // while the ready gate is still shut — the ready promise is released by this
  // test, not by the entry.
  await import("../../src/main/index.ts");
  const trace = () => recorder.events.join(" -> ");
  assert.ok(
    recorder.events.includes("setPath:userData"),
    `userData must be redirected while the ready gate is still shut, before ` +
      `the entry asks when it is ready; observed: ${trace()}`,
  );
  assert.ok(
    !recorder.events.includes("ready-resolved"),
    `nothing may cross the ready gate during module evaluation; observed: ${trace()}`,
  );
  assert.ok(
    !recorder.events.includes("window-created"),
    `no window may exist before the redirect; observed: ${trace()}`,
  );

  releaseReady();
  assert.ok(
    await waitForEvent(recorder, "window-created"),
    `the entry must reach the first window after ready; observed: ${trace()}`,
  );

  const at = (event) => recorder.events.indexOf(event);
  const order = [
    ["setPath:sessionData", "redirect the session profile"],
    ["setPath:userData", "redirect the user-data directory"],
    ["ready-resolved", "the app becoming ready"],
    [`session.fromPartition:${IDENTITY_PARTITION}`, "the first session access"],
    ["window-created", "the first window"],
  ].map(([event, description]) => [event, description, at(event)]);
  for (const [event, description, index] of order) {
    assert.notEqual(
      index,
      -1,
      `the entry must ${description} (${event}); observed: ${trace()}`,
    );
  }
  for (let index = 1; index < order.length; index += 1) {
    const [previousEvent, previousDescription, previousIndex] =
      order[index - 1];
    const [event, description, indexOfEvent] = order[index];
    assert.ok(
      previousIndex < indexOfEvent,
      `the entry must ${previousDescription} (${previousEvent}) before it ` +
        `${description} (${event}); observed: ${trace()}`,
    );
  }

  // Corroboration only: the redirect must land on the ProgramData layout, not
  // merely happen earlier. The order above is the assertion that bites.
  const fake = await import(fakeElectron);
  const userDirectory = path.join(
    process.env.PROGRAMDATA,
    PROFILE_DIRECTORY_NAME,
    USERS_DIRECTORY_NAME,
    "probe-user",
  );
  assert.equal(
    fake.__paths.sessionData,
    path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
  );
  assert.equal(
    fake.__paths.userData,
    path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  );
  // appData is the OS roaming ROOT and is deliberately never redirected: it is
  // only the blank-PROGRAMDATA fallback base. The two Electron data paths are
  // the ones that must have moved.
  for (const name of [SESSION_DATA_PATH_NAME, USER_DATA_PATH_NAME]) {
    assert.ok(
      !fake.__paths[name].startsWith(fake.__defaults.appData),
      `${name} still points into the roaming default: ${fake.__paths[name]}`,
    );
  }
});
