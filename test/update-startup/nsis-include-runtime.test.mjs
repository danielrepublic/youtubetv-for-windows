// NSIS runtime harness for the committed build/nsis.include handoff macros.
//
// This suite is the ONLY executable proof of the installer-side protocol:
// a purpose-built standalone `.nsi` includes the real `build/nsis.include`
// and drives its namespaced macros with a stub "parent" process and a stub
// "app" executable.
//
// Cases:
//   wait      - the parent is alive: NO install action happens; after the
//               parent dies the install completes, the atomic marker is
//               written, and the app is relaunched with the nonce.
//   timeout   - the parent never dies: the harness aborts with a nonzero
//               exit code and replaces nothing.
//   normal    - no handoff flags: an ordinary install, no marker/relaunch.
//   partial   - only one flag: abort, nothing runs.
//   traversal - a nonce that tries to escape the status directory: abort.
//
// The NSIS toolchain is the one electron-builder caches. When it is not
// available (no scratch build has run on this machine yet) every case is
// reported as an explicit skip with the exact remedy, never as a pass.

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

const NONCE = "0123456789abcdef0123456789abcdef";
const STUB_APP_NAME = "youtubetv-for-windows.exe";

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

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

function compile(scriptPath) {
  const result = spawnSync(makensisPath, [path.basename(scriptPath)], {
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

function spawnHarness(executablePath, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
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

function startStubParent() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function killProcess(pid) {
  spawnSync("taskkill", ["/pid", String(pid), "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

function recorderSource() {
  return `Unicode true
Name "ytvw-relaunch-recorder"
OutFile "recorder.exe"
SilentInstall silent
RequestExecutionLevel user
Section
  FileOpen $0 "$EXEDIR\\relaunch.log" a
  FileWrite $0 "$CMDLINE$\\r$\\n"
  FileClose $0
SectionEnd
`;
}

function harnessSource({ directory, timeoutMs }) {
  const installDir = path.join(directory, "install");
  const statusDir = path.join(directory, "status");
  const recorderPath = path.join(directory, "recorder.exe");
  return `Unicode true
Name "ytvw-harness"
OutFile "harness.exe"
SilentInstall silent
RequestExecutionLevel user
InstallDir "${installDir}"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APP_EXECUTABLE_FILENAME "${STUB_APP_NAME}"
!define YTVW_STATUS_DIR "${statusDir}"
!define YTVW_PARENT_WAIT_TIMEOUT_MS ${timeoutMs}
!define YTVW_PARENT_POLL_INTERVAL_MS 100
!addincludedir "${path.dirname(includePath)}"
!include "nsis.include"

Function .onInit
  SetOutPath $INSTDIR
  FileOpen $0 "${directory}\\oninit-entered.txt" w
  FileWrite $0 "entered"
  FileClose $0
  !insertmacro customInit
  FileOpen $0 "${directory}\\oninit-passed.txt" w
  FileWrite $0 "passed"
  FileClose $0
FunctionEnd

Section "install"
  SetOutPath $INSTDIR
  File "/oname=${STUB_APP_NAME}" "${recorderPath}"
  FileOpen $0 "${directory}\\install-completed.txt" w
  FileWrite $0 "installed"
  FileClose $0
  !insertmacro customInstall
SectionEnd
`;
}

function createCaseDirectory(t, name) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-nsis-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(directory, "recorder.nsi"),
    recorderSource(),
    "utf8",
  );
  const timeoutMs = name === "timeout" ? 1500 : 30000;
  fs.writeFileSync(
    path.join(directory, "harness.nsi"),
    harnessSource({ directory, timeoutMs }),
    "utf8",
  );
  compile(path.join(directory, "recorder.nsi"));
  compile(path.join(directory, "harness.nsi"));
  return {
    directory,
    harness: path.join(directory, "harness.exe"),
    onInitEntered: path.join(directory, "oninit-entered.txt"),
    onInitPassed: path.join(directory, "oninit-passed.txt"),
    installCompleted: path.join(directory, "install-completed.txt"),
    statusDirectory: path.join(directory, "status"),
    relaunchLog: path.join(directory, "install", "relaunch.log"),
  };
}

test("the include is present and namespaced", { skip: false }, () => {
  assert.equal(fs.existsSync(includePath), true);
  const source = fs.readFileSync(includePath, "utf8");
  assert.match(source, /!macro customInit/);
  assert.match(source, /!macro customInstall/);
  assert.match(source, /!macro YTVW_WAIT_FOR_PARENT/);
  assert.match(source, /!macro YTVW_WRITE_SUCCESS_MARKER/);
  assert.match(source, /!macro YTVW_RELAUNCH_APP/);
});

test(
  "the installer waits for the exact parent, then publishes the atomic marker and relaunches",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCaseDirectory(t, "wait");
    const parent = startStubParent();
    t.after(() => {
      killProcess(parent.pid);
    });

    const exitPromise = spawnHarness(harnessCase.harness, [
      "/S",
      `--update-parent-pid=${parent.pid}`,
      `--update-nonce=${NONCE}`,
    ]);

    // While the parent lives, nothing may be installed and no marker may
    // appear. The poll interval is 100 ms in this harness, so 1.5 s is
    // comfortably more than one poll cycle.
    await sleep(1500);
    assert.equal(
      fs.existsSync(harnessCase.installCompleted),
      false,
      "no install action while the parent process is alive",
    );
    assert.equal(
      fs.existsSync(harnessCase.onInitPassed),
      false,
      "the installer must still be waiting in .onInit",
    );
    assert.equal(fs.existsSync(harnessCase.statusDirectory), false);

    killProcess(parent.pid);
    const exitCode = await exitPromise;
    assert.equal(
      exitCode,
      0,
      "the harness must complete after the parent exits",
    );

    assert.equal(fs.existsSync(harnessCase.onInitPassed), true);
    assert.equal(fs.existsSync(harnessCase.installCompleted), true);

    const markerPath = path.join(
      harnessCase.statusDirectory,
      `success-${NONCE}.json`,
    );
    assert.equal(fs.existsSync(markerPath), true, "the marker must exist");
    assert.equal(
      fs.readFileSync(markerPath, "utf8"),
      `{"nonce":"${NONCE}"}`,
      "the marker payload must carry the exact nonce",
    );
    assert.deepEqual(
      fs.readdirSync(harnessCase.statusDirectory),
      [`success-${NONCE}.json`],
      "no temporary marker file may survive the atomic publish",
    );

    assert.equal(
      await waitFor(() => fs.existsSync(harnessCase.relaunchLog)),
      true,
      "the app must be relaunched",
    );
    const relaunch = fs.readFileSync(harnessCase.relaunchLog, "utf8");
    assert.match(relaunch, new RegExp(STUB_APP_NAME.replace(".", "\\.")));
    assert.ok(
      relaunch.includes(`--update-nonce=${NONCE}`),
      `the relaunch must carry the nonce: ${relaunch}`,
    );
  },
);

test(
  "a parent that never exits aborts with a nonzero code and replaces nothing",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCaseDirectory(t, "timeout");
    const parent = startStubParent();
    t.after(() => {
      killProcess(parent.pid);
    });

    const exitCode = await spawnHarness(harnessCase.harness, [
      "/S",
      `--update-parent-pid=${parent.pid}`,
      `--update-nonce=${NONCE}`,
    ]);

    assert.notEqual(exitCode, 0, "a wait timeout must fail the installer");
    assert.equal(exitCode, 3, "the documented timeout exit code");
    assert.equal(fs.existsSync(harnessCase.onInitPassed), false);
    assert.equal(fs.existsSync(harnessCase.installCompleted), false);
    assert.equal(fs.existsSync(harnessCase.statusDirectory), false);
    assert.equal(fs.existsSync(harnessCase.relaunchLog), false);
  },
);

test(
  "an ordinary install run is unaffected by the include",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCaseDirectory(t, "normal");
    const exitCode = await spawnHarness(harnessCase.harness, ["/S"]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(harnessCase.installCompleted), true);
    assert.equal(fs.existsSync(harnessCase.statusDirectory), false);
    assert.equal(fs.existsSync(harnessCase.relaunchLog), false);
  },
);

test(
  "a partial handoff aborts before any action",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCaseDirectory(t, "partial");
    const exitCode = await spawnHarness(harnessCase.harness, [
      "/S",
      "--update-nonce=deadbeefdeadbeefdeadbeefdeadbeef",
    ]);
    assert.equal(exitCode, 2, "the documented bad-handoff exit code");
    assert.equal(fs.existsSync(harnessCase.installCompleted), false);
    assert.equal(fs.existsSync(harnessCase.statusDirectory), false);
  },
);

test(
  "a traversal-shaped nonce aborts and never reaches the filesystem",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCaseDirectory(t, "traversal");
    const exitCode = await spawnHarness(harnessCase.harness, [
      "/S",
      "--update-parent-pid=1",
      "--update-nonce=..\\..\\escape",
    ]);
    assert.equal(exitCode, 2, "the documented bad-handoff exit code");
    assert.equal(fs.existsSync(harnessCase.installCompleted), false);
    assert.equal(
      fs.existsSync(path.join(harnessCase.directory, "escape.json")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(harnessCase.directory, "..", "escape.json")),
      false,
    );
  },
);
