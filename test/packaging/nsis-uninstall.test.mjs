// Task-7 uninstaller harness for the committed `build/nsis.include`.
//
// This suite is the executable proof of the uninstall half: a standalone
// `.nsi` compiled WITH `BUILD_UNINSTALLER` defined includes the real
// `build/nsis.include` and drives `customUnInstall` against scratch local and
// roaming data trees (the `YTVW_*` roots/names are overridden to TEMP
// directories, so the real `%LOCALAPPDATA%` and `%APPDATA%` are never
// touched).
//
// Cases:
//   remove   - populated local and roaming trees, real uninstall flags: both
//              whole trees are gone, exit 0.
//   upgrade  - `/KEEP_APP_DATA` (what `uninstallOldVersion` always passes
//              during an installer-driven upgrade): the tree is kept
//              byte-identical, exit 0. The sign-in profile survives updates.
//   locked   - an exclusively-locked roaming file, silent run: nonzero exit
//              and the locked tree remains. The bilingual message is shown
//              interactively and skipped (`/SD IDOK`) in silent mode, so this
//              never hangs.
//   missing  - no tree at all: exit 0, nothing happens.
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

const DATA_DIR_NAME = "ytvw-test-profile";
const ROAMING_DATA_DIR_NAME = "ytvw-test-electron-userdata";

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

function harnessSource(directory) {
  // An uninstaller-mode script needs an install section to exist at all
  // ("invalid script: no sections specified" otherwise) and a
  // `WriteUninstaller` call from install-side code (warning 6020, promoted
  // to an error by `-WX`, otherwise) — mirroring how installer.nsi shapes
  // the real uninstaller build.
  return `Unicode true
Name "ytvw-uninstall-harness"
OutFile "uninstall-harness.exe"
SilentInstall silent
RequestExecutionLevel user

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define BUILD_UNINSTALLER
!define YTVW_DATA_ROOT "${directory}"
!define YTVW_DATA_DIR_NAME "${DATA_DIR_NAME}"
!define YTVW_ROAMING_DATA_ROOT "${directory}\\roaming-root"
!define YTVW_ROAMING_DATA_DIR_NAME "${ROAMING_DATA_DIR_NAME}"
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

function createCase(t, name) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-uninst-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(directory, "harness.nsi"),
    harnessSource(directory),
    "utf8",
  );
  compile(path.join(directory, "harness.nsi"));
  return {
    directory,
    harness: path.join(directory, "uninstall-harness.exe"),
    uninstaller: path.join(directory, "inner-uninstaller.exe"),
    dataDirectory: path.join(directory, DATA_DIR_NAME),
    roamingDataDirectory: path.join(
      directory,
      "roaming-root",
      ROAMING_DATA_DIR_NAME,
    ),
  };
}

function populateTree(dataDirectory, prefix) {
  const files = {
    "profile/Cookies": `${prefix}-cookie-bytes`,
    "profile/Preferences": `${prefix}-{}`,
    "updates/lock": `${prefix}-lock-bytes`,
    "update-status/success-abc.json": `{"nonce":"${prefix}-abc"}`,
    "diagnostics/ENABLED": prefix,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dataDirectory, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
  }
  return files;
}

function snapshotTree(dataDirectory) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        entries.push({
          relative: path.relative(dataDirectory, full),
          contents: fs.readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(dataDirectory);
  return entries.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

test(
  "a real uninstall removes both local profile and roaming Electron user-data trees",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "remove");
    const localBefore = populateTree(harnessCase.dataDirectory, "local");
    const roamingBefore = populateTree(
      harnessCase.roamingDataDirectory,
      "roaming",
    );
    assert.ok(Object.keys(localBefore).length > 0);
    assert.ok(Object.keys(roamingBefore).length > 0);

    const exitCode = await runUninstaller(harnessCase, []);
    assert.equal(exitCode, 0, "a clean removal must succeed");
    assert.equal(
      fs.existsSync(harnessCase.dataDirectory),
      false,
      "profile, updates, markers, and diagnostics must all be gone",
    );
    assert.equal(
      fs.existsSync(harnessCase.roamingDataDirectory),
      false,
      "Electron's default roaming userData tree must also be gone",
    );
  },
);

test(
  "an upgrade uninstall keeps local profile and roaming Electron user-data trees byte-identical",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "upgrade");
    populateTree(harnessCase.dataDirectory, "local");
    populateTree(harnessCase.roamingDataDirectory, "roaming");
    const localBefore = snapshotTree(harnessCase.dataDirectory);
    const roamingBefore = snapshotTree(harnessCase.roamingDataDirectory);

    const exitCode = await runUninstaller(harnessCase, ["/KEEP_APP_DATA"]);
    assert.equal(exitCode, 0, "the upgrade path must succeed");
    assert.deepEqual(
      snapshotTree(harnessCase.dataDirectory),
      localBefore,
      "the local sign-in profile must survive updates",
    );
    assert.deepEqual(
      snapshotTree(harnessCase.roamingDataDirectory),
      roamingBefore,
      "Electron's roaming userData tree must survive updates",
    );
  },
);

test(
  "a locked roaming tree fails with a nonzero exit and keeps the locked tree",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "locked");
    populateTree(harnessCase.dataDirectory, "local");
    populateTree(harnessCase.roamingDataDirectory, "roaming");
    const lockedFile = path.join(
      harnessCase.roamingDataDirectory,
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
    assert.equal(fs.existsSync(harnessCase.dataDirectory), false);
    const exitCode = await runUninstaller(harnessCase, []);
    assert.equal(exitCode, 0);
  },
);
