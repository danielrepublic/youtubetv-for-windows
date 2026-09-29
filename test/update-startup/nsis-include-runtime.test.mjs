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
//   probe-error - the liveness probe cannot be launched at all, so nsExec
//               pushes a non-numeric error string instead of an exit code,
//               while the parent is alive: the harness must wait to its
//               deadline and abort without installing anything.
//   probe-exit-nonzero - the liveness probe runs and exits 2 (findstr
//               itself failed) while the parent is alive: same expectation.
//   fail-closed-decision - a source-level pin: the retired `!= 0` decision
//               (any nonzero nsExec result means "the parent is gone") must
//               never return, and the default probe command must stay
//               byte-identical to the pre-seam inline command.
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
// The command YTVW_WAIT_FOR_PARENT passed inline to `nsExec::Exec` at HEAD
// 1d3feb0, before the YTVW_PARENT_PROBE_COMMAND seam existed. The seam is a
// compile-time default that production never overrides, so the probe the
// shipped installer runs must still be exactly this text.
const HISTORICAL_PROBE_COMMAND =
  '"$SYSDIR\\cmd.exe" /C tasklist /FI "PID eq ${pid}" /FO CSV /NH | ' +
  '"$SYSDIR\\findstr.exe" /C:,\\"${pid}\\",';
// SUPPORTED CONCURRENCY: three concurrent copies of this suite, optionally
// with a CPU/IO load generator. That is the condition this suite is verified
// at, and it is what the wall-clock budget below is sized for. The budget is
// generous on purpose - the earlier 60 s budget was the deciding factor in a
// 10-way oversubscription run, where the harness was killed by its OWN timer
// while it was behaving correctly - but it is not a claim of immunity to
// arbitrary starvation: no finite budget survives an unbounded number of
// competing copies, and this constant is the documented place to raise it if
// that ceiling is ever needed.
const HARNESS_WALL_CLOCK_TIMEOUT_MS = 180000;

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

function compile(scriptPath, definitions = []) {
  const result = spawnSync(
    makensisPath,
    [
      "-WX",
      ...definitions.map((definition) => `-D${definition}`),
      path.basename(scriptPath),
    ],
    {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(
    result.status,
    0,
    `makensis failed for ${scriptPath}: ${result.stdout}\n${result.stderr}`,
  );
}

function spawnHarness(
  executablePath,
  args,
  timeoutMs = HARNESS_WALL_CLOCK_TIMEOUT_MS,
) {
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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only "gone" answer; EPERM means the process exists but
    // cannot be signalled, so it must still count as alive.
    return error.code !== "ESRCH";
  }
}

async function waitForProcessExit(pid, timeoutMs = 15000) {
  return await waitFor(() => !isProcessAlive(pid), timeoutMs);
}

function processImageName(pid) {
  const result = spawnSync(
    "tasklist",
    ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  const match = /^"([^"]+)"/m.exec(result.stdout ?? "");
  return match === null ? "" : match[1];
}

async function removeCaseDirectory(directory) {
  const attempts = 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        // A path that survives the whole bounded budget is a genuine
        // failure and must stay observable, naming the leftover path.
        throw new Error(
          `the case directory could not be removed after ${attempts} ` +
            `attempts, leftover path: ${directory}: ${error.message}`,
          { cause: error },
        );
      }
      // Bounded backoff for transient holders (a stub that is still exiting,
      // an antivirus scan of the freshly written executable).
      await sleep(100 * (attempt + 1));
    }
  }
}

// Shared probe-failure proof: while the parent is alive, a probe that cannot
// report the exact no-match result must keep polling to its deadline, then
// abort with the documented timeout code and touch nothing.
async function assertProbeFailureAbortsAfterDeadline(
  t,
  { name, probeLabel, compileDefinitions },
) {
  const harnessCase = createCaseDirectory(t, name, {
    timeoutMs: 1500,
    compileDefinitions,
  });
  const parent = startStubParent();
  t.after(() => {
    killProcess(parent.pid);
  });

  const startedAt = Date.now();
  const exitCode = await spawnHarness(harnessCase.harness, [
    "/S",
    `--update-parent-pid=${parent.pid}`,
    `--update-nonce=${NONCE}`,
  ]);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(
    isProcessAlive(parent.pid),
    true,
    `the stub parent must still be alive when the ${probeLabel} wait aborts`,
  );
  assert.equal(exitCode, 3, "the documented timeout exit code");
  assert.ok(
    elapsedMs >= 1200,
    `a ${probeLabel} must wait through the 1500 ms deadline, got ${elapsedMs} ms`,
  );
  assert.equal(fs.existsSync(harnessCase.onInitPassed), false);
  assert.equal(fs.existsSync(harnessCase.installCompleted), false);
  assert.equal(fs.existsSync(harnessCase.statusDirectory), false);
  assert.equal(fs.existsSync(harnessCase.relaunchLog), false);
}

function recorderSource() {
  return `Unicode true
Name "ytvw-relaunch-recorder"
OutFile "recorder.exe"
SilentInstall silent
RequestExecutionLevel user
Section
  ; NSIS 3.0 has no $PID variable; the System plugin reports the real
  ; process id. It is written FIRST so the harness can wait for this exact
  ; process to exit before removing the directory its image is mapped from.
  System::Call "kernel32::GetCurrentProcessId() i .r0"
  FileOpen $0 "$EXEDIR\\recorder-pid.txt" w
  FileWrite $0 "$0"
  FileClose $0
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

function createCaseDirectory(
  t,
  name,
  {
    timeoutMs = name === "timeout" ? 1500 : 30000,
    compileDefinitions = [],
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-nsis-${name}-`),
  );
  t.after(async () => {
    // The relaunched stub may still be exiting when the test finishes; the
    // bounded retry releases the path once the holder is gone, and still
    // fails the run (naming the leftover path) when it never is.
    await removeCaseDirectory(directory);
  });
  fs.writeFileSync(
    path.join(directory, "recorder.nsi"),
    recorderSource(),
    "utf8",
  );
  fs.writeFileSync(
    path.join(directory, "harness.nsi"),
    harnessSource({ directory, timeoutMs }),
    "utf8",
  );
  compile(path.join(directory, "recorder.nsi"));
  compile(path.join(directory, "harness.nsi"), compileDefinitions);
  return {
    directory,
    harness: path.join(directory, "harness.exe"),
    onInitEntered: path.join(directory, "oninit-entered.txt"),
    onInitPassed: path.join(directory, "oninit-passed.txt"),
    installCompleted: path.join(directory, "install-completed.txt"),
    statusDirectory: path.join(directory, "status"),
    relaunchLog: path.join(directory, "install", "relaunch.log"),
    recorderPidFile: path.join(directory, "install", "recorder-pid.txt"),
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
  "the parent-liveness decision is fail closed and the default probe command is unchanged",
  { skip: false },
  () => {
    const source = fs.readFileSync(includePath, "utf8");

    const macroStart = source.indexOf("!macro YTVW_WAIT_FOR_PARENT");
    const macroEnd = source.indexOf("!macroend", macroStart);
    assert.ok(macroStart > 0 && macroEnd > macroStart, "the wait macro exists");
    const waitMacro = source.slice(macroStart, macroEnd);

    // The retired decision read ANY nonzero nsExec result as "no such
    // process", so an exit-2 findstr failure and a non-numeric nsExec launch
    // error both concluded the parent was gone. That is the fail-open this
    // test pins shut, and it must not be reintroduced in any spelling.
    assert.doesNotMatch(
      waitMacro,
      /\$ytvwTasklistCode\s*!=\s*0/,
      "the wait must not treat a nonzero probe result as absence",
    );
    assert.doesNotMatch(
      waitMacro,
      /\$ytvwTasklistCode\s*(==|!=)/,
      "the raw probe value must be classified, never compared directly",
    );

    // Fail-closed default plus an explicit three-state classification, where
    // only the exact no-match state may end the wait.
    assert.match(
      waitMacro,
      /StrCpy \$ytvwProbeOutcome "failed"/,
      "an unrecognised probe result must default to a failed probe",
    );
    assert.match(
      waitMacro,
      /IntOp \$ytvwProbeNumeric \$ytvwTasklistCode \+ 0/,
      "the probe value must be round-tripped to detect a non-numeric one",
    );
    assert.match(
      waitMacro,
      /\$\{If\} \$ytvwProbeOutcome == "gone"/,
      "only the gone state may end the wait",
    );

    // The seam must default to the pre-seam command byte for byte, so no
    // shipped build can probe anything other than what it always probed.
    const defaultMatch =
      /^\s*!define YTVW_PARENT_PROBE_COMMAND\s+`([^`]*)`\s*$/m.exec(source);
    assert.ok(
      defaultMatch !== null,
      "the probe command must be a compile-time default with a backquoted value",
    );
    assert.equal(
      defaultMatch[1],
      HISTORICAL_PROBE_COMMAND,
      "the default probe command must stay byte-identical to the historical " +
        "inline command",
    );
  },
);

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
    // The recorder creates the log on open and writes the payload right
    // after; under load the first observation can precede the write. Wait
    // (bounded) for the payload so the unchanged assertions below never read
    // an empty snapshot of a healthy relaunch.
    assert.equal(
      await waitFor(() =>
        fs
          .readFileSync(harnessCase.relaunchLog, "utf8")
          .includes(`--update-nonce=${NONCE}`),
      ),
      true,
      "the relaunch log must carry the nonce within the wait budget",
    );
    const relaunch = fs.readFileSync(harnessCase.relaunchLog, "utf8");
    assert.match(relaunch, new RegExp(STUB_APP_NAME.replace(".", "\\.")));
    assert.ok(
      relaunch.includes(`--update-nonce=${NONCE}`),
      `the relaunch must carry the nonce: ${relaunch}`,
    );

    // The relaunch is asynchronous (the include uses NSIS `Exec`): the stub
    // can still be running when this test finishes, and its mapped image
    // locks `install\${STUB_APP_NAME}` inside the case directory, so the
    // `t.after` removal would fail with EPERM under load. Wait for the exact
    // process the stub recorded; only when it survives the graceful budget is
    // it killed (after an image-name check) and awaited again.
    const recorderPid = Number.parseInt(
      fs.readFileSync(harnessCase.recorderPidFile, "utf8"),
      10,
    );
    assert.ok(
      Number.isInteger(recorderPid) && recorderPid > 0,
      `the relaunched stub must record its pid: ${harnessCase.recorderPidFile}`,
    );
    let recorderExited = await waitForProcessExit(recorderPid);
    if (!recorderExited && processImageName(recorderPid) === STUB_APP_NAME) {
      killProcess(recorderPid);
      recorderExited = await waitForProcessExit(recorderPid, 5000);
    }
    assert.equal(
      recorderExited,
      true,
      `the relaunched stub (pid ${recorderPid}) must release ` +
        `${harnessCase.directory} before the cleanup hook runs`,
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
  "a liveness probe that cannot launch waits to its deadline and never installs while its parent lives",
  { skip: skipReason },
  async (t) => {
    await assertProbeFailureAbortsAfterDeadline(t, {
      name: "probe-error",
      probeLabel: "launch-failing probe",
      compileDefinitions: [
        `YTVW_PARENT_PROBE_COMMAND="$SYSDIR\\ytvw-missing-parent-probe.exe"`,
      ],
    });
  },
);

test(
  "a liveness probe that reports a nonzero failure code waits to its deadline and never installs while its parent lives",
  { skip: skipReason },
  async (t) => {
    await assertProbeFailureAbortsAfterDeadline(t, {
      name: "probe-exit-nonzero",
      probeLabel: "nonzero-exit probe",
      compileDefinitions: [`YTVW_PARENT_PROBE_COMMAND=cmd.exe /C exit 2`],
    });
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
