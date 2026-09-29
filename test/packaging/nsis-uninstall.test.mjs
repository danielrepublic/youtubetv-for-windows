// Task-8 uninstaller harness for the committed `build/nsis.include`.
//
// This suite is the executable proof of the uninstall half: a standalone
// `.nsi` compiled WITH `BUILD_UNINSTALLER` defined includes the real
// `build/nsis.include` and drives `customUnInstall` against a scratch
// ProgramData-shaped machine tree (`YTVW_MACHINE_ROOT` is overridden to a
// TEMP directory, so the real `%PROGRAMDATA%` is never touched).
//
// The tree mirrors `src/main/profile-path.ts`: the machine root holds one
// `users\<key>` leaf per Windows user, each with `profile` (Chromium session
// data, including `Cookies`) and `userdata` (Electron userData).
//
// Cases:
//   remove   - a populated machine tree, real uninstall flags: the whole
//              tree is gone, exit 0.
//   upgrade  - `/KEEP_APP_DATA` (what `uninstallOldVersion` always passes
//              during an installer-driven upgrade): the tree is kept
//              byte-identical, exit 0. Sign-in survives updates.
//   locked   - an exclusively-locked `users\<key>\profile\Cookies`, silent
//              run: nonzero exit and the locked file remains. The bilingual
//              message is shown interactively and skipped (`/SD IDOK`) in
//              silent mode, so this never hangs.
//   missing  - no tree at all: exit 0, nothing happens.
//   blank    - the base resolves blank (empty `YTVW_MACHINE_ROOT` override):
//              exit 0 with the on-disk tree untouched, proving the removal
//              is skipped instead of degenerating to a drive-relative
//              recursive delete.
//
// The NSIS toolchain is the one electron-builder caches. When it is not
// available every case is reported as an explicit skip with the exact
// remedy, never as a pass.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const includePath = path.join(repositoryRoot, "build", "nsis.include");

// The committed `YTVW_MACHINE_DIR_NAME` default; deliberately NOT overridden,
// so the harness exercises the real directory name.
const MACHINE_DIR_NAME = "youtubetv-for-windows";
const USER_KEY_A = "TestUser";
const USER_KEY_B = "Other.User-2";

function findMakensis() {
  const candidates = [];
  if (typeof process.env.YTVW_MAKENSIS === "string") {
    candidates.push(process.env.YTVW_MAKENSIS);
  }
  const cacheRoots = [
    path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache"),
    path.join(process.env.LOCALAPPDATA ?? "", "electron-builder"),
  ];
  for (const cacheRoot of cacheRoots) {
    if (cacheRoot.length === 0 || !fs.existsSync(cacheRoot)) {
      continue;
    }
    for (const entry of fs.readdirSync(cacheRoot)) {
      if (!entry.startsWith("nsis-")) {
        continue;
      }
      const versionsRoot = path.join(cacheRoot, entry);
      for (const inner of fs.readdirSync(versionsRoot)) {
        candidates.push(path.join(versionsRoot, inner, "Bin", "makensis.exe"));
      }
    }
  }
  for (const programFiles of [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
  ]) {
    if (typeof programFiles === "string" && programFiles.length > 0) {
      candidates.push(path.join(programFiles, "NSIS", "makensis.exe"));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const makensisPath = findMakensis();
const skipReason =
  makensisPath === null
    ? "makensis.exe was not found (electron-builder NSIS cache empty). " +
      "Run the bounded scratch build documented in " +
      "release-evidence/update-startup/ to populate " +
      "%LOCALAPPDATA%\\electron-builder\\Cache\\nsis-*."
    : false;

function compile(scriptPath) {
  const result = spawnSync(makensisPath, ["-WX", path.basename(scriptPath)], {
    cwd: path.dirname(scriptPath),
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(
    result.status,
    0,
    `makensis failed for ${scriptPath}: ${result.stdout}\n${result.stderr}`,
  );
}

function runSilent(executablePath, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["/S", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      reject(new Error(`harness timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

function harnessSource(machineBase, { blankBase = false } = {}) {
  // An uninstaller-mode script needs an install section to exist at all
  // ("invalid script: no sections specified" otherwise) and a
  // `WriteUninstaller` call from install-side code (warning 6020, promoted
  // to an error by `-WX`, otherwise) — mirroring how installer.nsi shapes
  // the real uninstaller build.
  const machineRootDefine = blankBase
    ? '!define YTVW_MACHINE_ROOT ""'
    : `!define YTVW_MACHINE_ROOT "${machineBase}"`;
  return `Unicode true
Name "ytvw-uninstall-harness"
OutFile "uninstall-harness.exe"
SilentInstall silent
RequestExecutionLevel user

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define BUILD_UNINSTALLER
# The per-machine enforcement guards in nsis.include are evaluated in both
# compiles, so this standalone uninstaller harness carries the same defines
# electron-builder passes to the real uninstaller build.
!define INSTALL_MODE_PER_ALL_USERS
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
${machineRootDefine}
!addincludedir "${path.dirname(includePath)}"
!include "nsis.include"

Function .onInit
  WriteUninstaller "$EXEDIR\\inner-uninstaller.exe"
FunctionEnd

Section "install"
SectionEnd

Section "un.test"
  !insertmacro customUnInstall
SectionEnd
`;
}

async function runUninstaller(harnessCase, args) {
  // The outer exe only runs the install side (which writes the generated
  // uninstaller from `.onInit`); the `un.test` section — and therefore
  // `customUnInstall` — runs only inside the generated uninstaller.
  assert.equal(
    await runSilent(harnessCase.harness, []),
    0,
    "the outer harness must complete",
  );
  assert.equal(
    fs.existsSync(harnessCase.uninstaller),
    true,
    "the outer harness must emit the generated uninstaller",
  );
  // `_?=` must be last, exactly like `uninstallOldVersion` invokes the real
  // uninstaller. Without it NSIS copies the uninstaller to TEMP and finishes
  // asynchronously; with it the run is synchronous and assertions are exact.
  return runSilent(harnessCase.uninstaller, [
    ...args,
    `_?=${harnessCase.directory}`,
  ]);
}

function createCase(t, name, options) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-uninst-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const machineBase = path.join(directory, "machine-base");
  fs.writeFileSync(
    path.join(directory, "harness.nsi"),
    harnessSource(machineBase, options),
    "utf8",
  );
  compile(path.join(directory, "harness.nsi"));
  return {
    directory,
    harness: path.join(directory, "uninstall-harness.exe"),
    uninstaller: path.join(directory, "inner-uninstaller.exe"),
    machineBase,
    machineRoot: path.join(machineBase, MACHINE_DIR_NAME),
  };
}

function populateTree(machineRoot, prefix) {
  const files = {
    [`users\\${USER_KEY_A}\\profile\\Cookies`]: `${prefix}-cookie-bytes`,
    [`users\\${USER_KEY_A}\\profile\\Preferences`]: `${prefix}-{}`,
    [`users\\${USER_KEY_A}\\userdata\\Local State`]: `${prefix}-local-state`,
    [`users\\${USER_KEY_B}\\profile\\Cookies`]: `${prefix}-second-cookie`,
    [`users\\${USER_KEY_B}\\userdata\\Session Storage\\000003.log`]: `${prefix}-session-bytes`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(machineRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return files;
}

function snapshotTree(machineRoot) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        entries.push({
          relative: path.relative(machineRoot, full),
          contents: fs.readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(machineRoot);
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

test(
  "a real uninstall removes the whole ProgramData machine tree",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "remove");
    const before = populateTree(harnessCase.machineRoot, "remove");
    assert.ok(Object.keys(before).length > 0);

    const exitCode = await runUninstaller(harnessCase, []);
    assert.equal(exitCode, 0, "a clean removal must succeed");
    assert.equal(
      fs.existsSync(harnessCase.machineRoot),
      false,
      "every users/<key> profile and userdata leaf must be gone with the machine root",
    );
  },
);

test(
  "an upgrade uninstall keeps the machine tree byte-identical",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "upgrade");
    populateTree(harnessCase.machineRoot, "upgrade");
    const before = snapshotTree(harnessCase.machineRoot);

    const exitCode = await runUninstaller(harnessCase, ["/KEEP_APP_DATA"]);
    assert.equal(exitCode, 0, "the upgrade path must succeed");
    assert.deepEqual(
      snapshotTree(harnessCase.machineRoot),
      before,
      "every user's sign-in profile must survive updates",
    );
  },
);

test(
  "a locked Cookies file fails with a nonzero exit and keeps the locked file",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "locked");
    populateTree(harnessCase.machineRoot, "locked");
    const lockedFile = path.join(
      harnessCase.machineRoot,
      "users",
      USER_KEY_A,
      "profile",
      "Cookies",
    );
    const holder = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `$s=[IO.File]::Open(${JSON.stringify(lockedFile)},'Open','Read','None'); Start-Sleep -Seconds 60`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    t.after(() => {
      spawnSync("taskkill", ["/pid", String(holder.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 1500);
    });

    const exitCode = await runUninstaller(harnessCase, []);
    assert.notEqual(exitCode, 0, "a lock failure must be observable");
    const includeSource = fs.readFileSync(includePath, "utf8");
    assert.match(
      includeSource,
      /無法移除設定檔與應用程式資料/,
      "the locked-tree failure must retain Traditional Chinese guidance",
    );
    assert.match(
      includeSource,
      /The profile and application data could not be removed/,
      "the locked-tree failure must retain English guidance",
    );
    assert.equal(
      fs.existsSync(lockedFile),
      true,
      "credentials must remain rather than be half-removed",
    );
    // Release the exclusive lock before the case directory is removed: the
    // `t.after` removal runs even when an assertion above throws, and it
    // cannot remove a directory whose files are still held open.
    spawnSync("taskkill", ["/pid", String(holder.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  },
);

test(
  "a missing tree is a successful no-op",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "missing");
    assert.equal(fs.existsSync(harnessCase.machineRoot), false);
    const exitCode = await runUninstaller(harnessCase, []);
    assert.equal(exitCode, 0);
  },
);

test(
  "a blank base is a successful no-op that leaves the on-disk tree untouched",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "blank", { blankBase: true });
    populateTree(harnessCase.machineRoot, "blank");
    const before = snapshotTree(harnessCase.machineRoot);

    const exitCode = await runUninstaller(harnessCase, []);
    assert.equal(exitCode, 0, "a blank base must not fail the uninstall");
    assert.deepEqual(
      snapshotTree(harnessCase.machineRoot),
      before,
      "a blank base must skip the removal instead of deleting drive-relatively",
    );
  },
);
