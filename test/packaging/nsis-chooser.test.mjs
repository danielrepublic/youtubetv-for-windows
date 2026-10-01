// Todo-9 already-installed chooser suite.
//
// `build/nsis.include` registers a `customPageAfterChangeDir` page that, when
// the app is already installed, offers reinstall / uninstall / cancel. This
// suite compiles and RUNS that real page against the real include:
//
//   - a first install never sees the page (its create function detects that
//     nothing is installed and aborts, which skips the page and lets the
//     install continue);
//   - the detection itself covers both an `InstallLocation` and the legacy
//     per-user executable, and reports "not installed" when neither exists;
//   - the uninstall choice runs the REAL generated uninstaller with `/S` and
//     WITHOUT `/KEEP_APP_DATA`, and the ProgramData machine tree is gone;
//   - the uninstall choice also removes the WHOLE install directory, the
//     uninstaller stub included, and the uninstaller resolves that directory
//     from outside it (it runs from the %TEMP% copy NSIS makes when `_?=` is
//     absent, which is the whole point of not passing `_?=`);
//   - the reinstall choice falls through without invoking the uninstaller and
//     leaves the machine tree byte-identical (the template's upgrade path is
//     what preserves the profile, via `/KEEP_APP_DATA`);
//   - the cancel choice exits before the section continues and touches
//     nothing;
//   - a `/S` run never invokes the page callbacks at all, so no prompt can
//     block a silent install;
//   - the page also compiles in the real assisted-UI page order (MUI, after
//     the directory page) at `-WX` with zero warnings.
//
// The detection inputs are driven through the documented `YTVW_INSTALL_LOCATION`
// and `YTVW_LEGACY_EXE` seams, so no test touches the real registry. The
// uninstall branch is observed by pointing `$INSTDIR` at a scratch directory
// holding a real makensis-generated uninstaller that records its own command
// line and removes a scratch ProgramData-shaped tree: the assertion is on the
// command the leave function actually built, not on a branch having run.

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
const buildDirectory = path.dirname(includePath);

// The committed `YTVW_MACHINE_DIR_NAME` default; deliberately NOT overridden,
// so the harness exercises the real directory name.
const MACHINE_DIR_NAME = "youtubetv-for-windows";
const UNINSTALLER_NAME = "Uninstall ytvw-chooser.exe";
const APP_EXE_NAME = "ytvw-chooser-app.exe";
const USER_KEY = "ChooserUser";

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
      if (!entry.startsWith("nsis-") || entry.endsWith(".7z")) {
        continue;
      }
      for (const inner of fs.readdirSync(path.join(cacheRoot, entry))) {
        candidates.push(
          path.join(cacheRoot, entry, inner, "Bin", "makensis.exe"),
        );
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

// nsDialogs.dll is what a custom page links against; the real build gets it
// from the makensis distribution's own plugin directory (electron-builder
// adds its plugin dir, which carries only StdUtils). Resolving it explicitly
// keeps the harness honest about where the plugin comes from.
function findNsDialogsPluginDirectory() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "electron-builder",
    "Cache",
  );
  if (!fs.existsSync(cacheRoot)) {
    return null;
  }
  for (const entry of fs.readdirSync(cacheRoot)) {
    if (!entry.startsWith("nsis-") || entry.endsWith(".7z")) {
      continue;
    }
    const versionsRoot = path.join(cacheRoot, entry);
    if (!fs.statSync(versionsRoot).isDirectory()) {
      continue;
    }
    for (const inner of fs.readdirSync(versionsRoot)) {
      const candidate = path.join(
        versionsRoot,
        inner,
        "Plugins",
        "x86-unicode",
        "nsDialogs.dll",
      );
      if (fs.existsSync(candidate)) {
        return path.dirname(candidate);
      }
    }
  }
  return null;
}

const makensisPath = findMakensis();
const pluginDirectory = findNsDialogsPluginDirectory();
const skipReason =
  makensisPath === null || pluginDirectory === null
    ? "makensis.exe or the nsDialogs plugin directory was not found " +
      "(electron-builder NSIS cache empty). Run the bounded scratch build " +
      "documented in release-evidence/update-startup/ to populate " +
      "%LOCALAPPDATA%\\electron-builder\\Cache\\nsis-*."
    : false;

function compile(directory, name) {
  const result = spawnSync(makensisPath, ["-WX", name], {
    cwd: directory,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0, `makensis failed for ${name}:\n${output}`);
  assert.ok(
    !/warning/i.test(output),
    `-WX must emit no warnings for ${name}:\n${output.slice(-800)}`,
  );
  const pages = /Install: (\d+) pages/.exec(output);
  return { output, pages: pages === null ? null : Number(pages[1]) };
}

// Runs the compiled installer. A page that does not skip itself hangs the
// non-silent run on its dialog, so a bounded timeout is part of the contract:
// it is what fails the "skip on first install" and "no prompt in /S" cases
// when the page is wrong. Resolves the exit code, or rejects on a hang.
function runInstaller(executablePath, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      reject(
        new Error(
          `the installer did not exit within ${timeoutMs}ms (a page prompt blocked it)`,
        ),
      );
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

function createCase(t, name) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-chooser-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const installDirectory = path.join(directory, "install");
  fs.mkdirSync(installDirectory);
  const machineBase = path.join(directory, "machine-base");
  return {
    directory,
    installDirectory,
    machineBase,
    machineRoot: path.join(machineBase, MACHINE_DIR_NAME),
    uninstallerPath: path.join(installDirectory, UNINSTALLER_NAME),
  };
}

function populateTree(machineRoot, prefix) {
  const files = {
    [`users\\${USER_KEY}\\profile\\Cookies`]: `${prefix}-cookie-bytes`,
    [`users\\${USER_KEY}\\profile\\Preferences`]: `${prefix}-{}`,
    [`users\\${USER_KEY}\\userdata\\Local State`]: `${prefix}-local-state`,
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

// A standalone BUILD_UNINSTALLER script that writes a real uninstaller whose
// un. section records its own command line and the directory it resolved, runs
// the include's `customUnInstall` (which removes the scratch ProgramData tree)
// and then removes the install directory the way electron-builder's real
// uninstall section does (`SetOutPath $TEMP` so nothing of the uninstaller is
// left in $INSTDIR, then `RMDir /r $INSTDIR`). This is the executable the
// chooser's uninstall branch launches.
function innerUninstallerSource(machineBase, argvLogPath, resolutionLogPath) {
  return [
    "Unicode true",
    'Name "ytvw-inner-uninstaller"',
    'OutFile "inner-outer.exe"',
    "SilentInstall silent",
    "RequestExecutionLevel user",
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    "!define BUILD_UNINSTALLER",
    "!define INSTALL_MODE_PER_ALL_USERS",
    "!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
    `!define YTVW_MACHINE_ROOT "${machineBase}"`,
    `!addincludedir "${buildDirectory}"`,
    '!include "nsis.include"',
    "Function .onInit",
    '  WriteUninstaller "$EXEDIR\\inner-uninstaller.exe"',
    "FunctionEnd",
    'Section "install"',
    "SectionEnd",
    'Section "un.record"',
    "  ${GetParameters} $0",
    `  FileOpen $1 "${argvLogPath}" w`,
    "  FileWrite $1 $0",
    "  FileClose $1",
    // Where the uninstaller is actually running from ($EXEDIR) and which
    // directory it resolved as the install directory ($INSTDIR). Written
    // AFTER the tree removal so a run that aborts on a lock still leaves the
    // resolution visible for the assertion message.
    `  FileOpen $1 "${resolutionLogPath}" w`,
    '  FileWrite $1 "EXEDIR=$EXEDIR INSTDIR=$INSTDIR"',
    "  FileClose $1",
    "  !insertmacro customUnInstall",
    "  SetOutPath $TEMP",
    "  RMDir /r $INSTDIR",
    "SectionEnd",
    "",
  ].join("\n");
}

// Builds the real uninstaller and drops it where the chooser looks for it
// (`$INSTDIR\<UNINSTALL_FILENAME>`), so the uninstall branch launches it for
// real rather than only building a command line.
function installInnerUninstaller(harnessCase) {
  const argvLogPath = path.join(harnessCase.directory, "uninstaller-argv.log");
  const resolutionLogPath = path.join(
    harnessCase.directory,
    "uninstaller-resolution.log",
  );
  fs.writeFileSync(
    path.join(harnessCase.directory, "inner.nsi"),
    innerUninstallerSource(
      harnessCase.machineBase,
      argvLogPath,
      resolutionLogPath,
    ),
    "utf8",
  );
  compile(harnessCase.directory, "inner.nsi");
  const status = spawnSync(
    path.join(harnessCase.directory, "inner-outer.exe"),
    ["/S"],
    {
      cwd: harnessCase.directory,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30000,
    },
  ).status;
  assert.equal(status, 0, "the inner uninstaller stub must run");
  const generated = path.join(harnessCase.directory, "inner-uninstaller.exe");
  assert.equal(
    fs.existsSync(generated),
    true,
    "the inner stub must generate a real uninstaller",
  );
  fs.copyFileSync(generated, harnessCase.uninstallerPath);
  return { argvLogPath, resolutionLogPath };
}

// The uninstaller that is launched WITHOUT `_?=` copies itself to %TEMP% and
// does the removal from there, so the stub returns before the removal
// finishes. Polling is therefore part of the contract, not a convenience:
// asserting immediately would race the copy.
function waitForRemoval(target, timeoutMs) {
  return waitFor(
    () => !fs.existsSync(target),
    timeoutMs,
    () => fs.existsSync(target),
  );
}

// Bounded poll for a condition the OS settles on its own schedule (a launched
// uninstaller finishing its removal, a log file appearing). The third argument
// is `stillPending`, a predicate that stays TRUE while the awaited state has
// not arrived, so the final answer is one last read of the caller's own
// condition rather than a guess. The wait between attempts is a timer, not a
// spawned helper process: the earlier shape spawned a `node` per poll, which
// cost ~200 processes across a 20 s window and made a filesystem check depend
// on process-start latency.
const POLL_INTERVAL_MS = 100;

async function waitFor(predicate, timeoutMs, stillPending) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return !stillPending();
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// The standalone installer that includes the real chooser. `detectionLines`
// carries the `YTVW_*` detection seams; `sectionLines` is the install
// section body (record markers, set `$ytvwChoice`, call the page callback).
function chooserSource(harnessCase, options) {
  const lines = [
    "Unicode true",
    'Name "ytvw-chooser-harness"',
    'OutFile "chooser.exe"',
    "RequestExecutionLevel user",
  ];
  lines.push(options.silent ? "SilentInstall silent" : "AutoCloseWindow true");
  lines.push(
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    `!addplugindir /x86-unicode "${pluginDirectory}"`,
    "!define INSTALL_MODE_PER_ALL_USERS",
    "!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
    '!define INSTALL_REGISTRY_KEY "Software\\ytvw-chooser-probe"',
    `!define APP_EXECUTABLE_FILENAME "${APP_EXE_NAME}"`,
    `!define UNINSTALL_FILENAME "${UNINSTALLER_NAME}"`,
  );
  lines.push(...options.detectionLines);
  lines.push(`!addincludedir "${buildDirectory}"`, '!include "nsis.include"');
  if (options.withPage !== false) {
    lines.push("!insertmacro customPageAfterChangeDir", "Page instfiles");
  }
  if (options.topLevelLines !== undefined) {
    lines.push(...options.topLevelLines);
  }
  lines.push('Section "install"');
  if (options.withPage !== false) {
    lines.push(`  StrCpy $INSTDIR "${harnessCase.installDirectory}"`);
  }
  lines.push(...options.sectionLines, "SectionEnd", "");
  return lines.join("\n");
}

function writeChooser(harnessCase, name, options) {
  const scriptPath = path.join(harnessCase.directory, `${name}.nsi`);
  fs.writeFileSync(scriptPath, chooserSource(harnessCase, options), "utf8");
  compile(harnessCase.directory, `${name}.nsi`);
  return path.join(harnessCase.directory, "chooser.exe");
}

function readMarker(directory, name) {
  const full = path.join(directory, name);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

// NSIS finishes a directory removal just after the launched process can
// return, so every absence assertion polls for a bounded window instead of
// sampling once. Returns null once gone, or the residue only after timeout.
async function waitUntilGone(target, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!fs.existsSync(target)) {
      return null;
    }
    if (Date.now() >= deadline) {
      return fs.readdirSync(target);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const NOT_INSTALLED_DETECTION = (harnessCase) => [
  '!define YTVW_INSTALL_LOCATION ""',
  `!define YTVW_LEGACY_EXE "${path.join(harnessCase.directory, "no-such-app.exe")}"`,
];

test(
  "a first install never sees the chooser page",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "first-install");
    const executable = writeChooser(harnessCase, "first", {
      silent: false,
      detectionLines: NOT_INSTALLED_DETECTION(harnessCase),
      sectionLines: [
        // `$ytvwInstalled` is written by the page's create function, so a
        // non-empty read proves the callback actually ran and decided.
        '  FileOpen $0 "$EXEDIR\\installed.txt" w',
        "  FileWrite $0 $ytvwInstalled",
        "  FileClose $0",
        '  FileOpen $0 "$EXEDIR\\section.txt" w',
        '  FileWrite $0 "ran"',
        "  FileClose $0",
      ],
    });

    // Non-silent: if the page did not skip itself, the run would hang on the
    // chooser dialog and this would time out.
    const exitCode = await runInstaller(executable, []);
    assert.equal(
      exitCode,
      0,
      "the first install must complete without a prompt",
    );
    assert.equal(
      readMarker(harnessCase.directory, "installed.txt"),
      "0",
      "the create function must run and find no installation",
    );
    assert.equal(
      readMarker(harnessCase.directory, "section.txt"),
      "ran",
      "the install section must still run after the page is skipped",
    );
  },
);

test(
  "detection reports an install from the machine-wide registry location",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "detect-registry");
    const executable = writeChooser(harnessCase, "detect-registry", {
      silent: true,
      withPage: false,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      topLevelLines: ["Var ytvwProbe"],
      sectionLines: [
        "  !insertmacro YTVW_DETECT_INSTALLED $ytvwProbe",
        '  FileOpen $0 "$EXEDIR\\detected.txt" w',
        "  FileWrite $0 $ytvwProbe",
        "  FileClose $0",
      ],
    });
    assert.equal(await runInstaller(executable, ["/S"]), 0);
    assert.equal(
      readMarker(harnessCase.directory, "detected.txt"),
      "1",
      "a registry InstallLocation must count as installed",
    );
  },
);

test(
  "detection reports an install from the legacy per-user executable",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "detect-legacy");
    const legacyExe = path.join(harnessCase.directory, "legacy-app.exe");
    fs.writeFileSync(legacyExe, "legacy", "utf8");
    const executable = writeChooser(harnessCase, "detect-legacy", {
      silent: true,
      withPage: false,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION ""',
        `!define YTVW_LEGACY_EXE "${legacyExe}"`,
      ],
      topLevelLines: ["Var ytvwProbe"],
      sectionLines: [
        "  !insertmacro YTVW_DETECT_INSTALLED $ytvwProbe",
        '  FileOpen $0 "$EXEDIR\\detected.txt" w',
        "  FileWrite $0 $ytvwProbe",
        "  FileClose $0",
      ],
    });
    assert.equal(await runInstaller(executable, ["/S"]), 0);
    assert.equal(
      readMarker(harnessCase.directory, "detected.txt"),
      "1",
      "the legacy per-user executable must count as installed",
    );
  },
);

test(
  "detection reports no install when neither location exists",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "detect-none");
    const executable = writeChooser(harnessCase, "detect-none", {
      silent: true,
      withPage: false,
      detectionLines: NOT_INSTALLED_DETECTION(harnessCase),
      topLevelLines: ["Var ytvwProbe"],
      sectionLines: [
        "  !insertmacro YTVW_DETECT_INSTALLED $ytvwProbe",
        '  FileOpen $0 "$EXEDIR\\detected.txt" w',
        "  FileWrite $0 $ytvwProbe",
        "  FileClose $0",
      ],
    });
    assert.equal(await runInstaller(executable, ["/S"]), 0);
    assert.equal(
      readMarker(harnessCase.directory, "detected.txt"),
      "0",
      "neither location being present must report not installed",
    );
  },
);

test(
  "the uninstall choice runs the real uninstaller with /S and no /KEEP_APP_DATA and removes the tree",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "uninstall");
    populateTree(harnessCase.machineRoot, "uninstall");
    const { argvLogPath } = installInnerUninstaller(harnessCase);
    const executable = writeChooser(harnessCase, "uninstall", {
      silent: true,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      sectionLines: [
        '  StrCpy $ytvwChoice "uninstall"',
        "  Call ytvwChooserLeave",
        '  FileOpen $0 "$EXEDIR\\after.txt" w',
        '  FileWrite $0 "after"',
        "  FileClose $0",
      ],
    });

    const exitCode = await runInstaller(executable, ["/S"]);
    assert.equal(exitCode, 0, "the uninstall choice must exit cleanly");
    // The %TEMP% copy is what records the command line, and it is what runs
    // after the stub returns, so the log is polled rather than read.
    assert.equal(
      await waitFor(
        () =>
          readMarker(harnessCase.directory, "uninstaller-argv.log") !== null,
        20000,
        () =>
          readMarker(harnessCase.directory, "uninstaller-argv.log") === null,
      ),
      true,
      "the uninstall branch must launch the real uninstaller",
    );
    const argv = readMarker(harnessCase.directory, "uninstaller-argv.log");
    assert.notEqual(
      argv,
      null,
      "the uninstall branch must launch the real uninstaller",
    );
    assert.match(argv, /\/S/, "the uninstaller must be launched silently");
    assert.ok(
      !argv.includes("/KEEP_APP_DATA"),
      `a full uninstall must NOT pass /KEEP_APP_DATA; got ${JSON.stringify(argv)}`,
    );
    // No `_?=` assertion here: NSIS strips that argument out of the parameter
    // string the uninstaller sees, so it cannot be observed from this side. The
    // residue case below is the guard - it fails on the in-place invocation.
    // Polled, because the uninstall branch is now asynchronous.
    assert.equal(
      await waitUntilGone(harnessCase.machineRoot),
      null,
      "the ProgramData machine tree must be gone after a full uninstall",
    );
    assert.equal(
      readMarker(harnessCase.directory, "after.txt"),
      null,
      "the uninstall choice exits before the section continues",
    );
    assert.equal(fs.existsSync(argvLogPath), true);
  },
);

test(
  "the uninstall choice removes the whole install directory, the uninstaller stub included",
  { skip: skipReason },
  async (t) => {
    // The regression guard for the residue real-machine QA found: launching
    // the uninstaller with `_?=$INSTDIR` makes it run IN PLACE, Windows locks
    // its own image, it cannot delete its stub, and the trailing
    // `RMDir /r $INSTDIR` fails, leaving `Uninstall <app>.exe` in a directory
    // the user was told uninstall removes
    // (08-chooser-real-uninstall.log: residue ["Uninstall youtubetv-for-windows.exe"]
    // on all 20 polls over 60 s).
    const harnessCase = createCase(t, "residue");
    populateTree(harnessCase.machineRoot, "residue");
    // The application payload the uninstaller has to take with it, so "the
    // directory is gone" cannot be satisfied by removing an empty folder.
    fs.writeFileSync(
      path.join(harnessCase.installDirectory, APP_EXE_NAME),
      "app-payload",
      "utf8",
    );
    const { argvLogPath, resolutionLogPath } =
      installInnerUninstaller(harnessCase);
    const executable = writeChooser(harnessCase, "residue", {
      silent: true,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      sectionLines: [
        '  StrCpy $ytvwChoice "uninstall"',
        "  Call ytvwChooserLeave",
      ],
    });

    assert.equal(
      await runInstaller(executable, ["/S"], 30000),
      0,
      "the uninstall choice must exit cleanly",
    );
    // The uninstaller that is launched WITHOUT `_?=` copies itself to %TEMP%
    // and does the removal from there, so the stub returns before the removal
    // finishes: poll, do not assert immediately.
    assert.equal(
      await waitForRemoval(harnessCase.installDirectory, 20000),
      true,
      `the install directory must be gone, the uninstaller stub included; residue: ${JSON.stringify(
        fs.existsSync(harnessCase.installDirectory)
          ? fs.readdirSync(harnessCase.installDirectory)
          : [],
      )}`,
    );
    assert.notEqual(
      readMarker(harnessCase.directory, "uninstaller-argv.log"),
      null,
      "the uninstall branch must still launch the real uninstaller",
    );
    assert.equal(fs.existsSync(argvLogPath), true);
    assert.equal(fs.existsSync(resolutionLogPath), true);
    // The uninstaller ran from somewhere other than the install directory and
    // still resolved the install directory correctly, which is why dropping
    // `_?=` does not cost the uninstaller its target: NSIS hands the original
    // directory to the %TEMP% copy, and the uninstaller's `un.onInit` ->
    // `initMultiUser` -> `setInstallModePerAllUsers` re-reads
    // `HKLM\Software\<guid>` `InstallLocation` on top of that.
    const resolution = fs.readFileSync(resolutionLogPath, "utf8");
    const resolved = /^EXEDIR=(.*) INSTDIR=(.*)$/.exec(resolution.trim());
    assert.notEqual(
      resolved,
      null,
      `the uninstaller must record where it ran and what it resolved; got ${JSON.stringify(resolution)}`,
    );
    const [, exedir, instdir] = resolved;
    assert.equal(
      path.resolve(instdir).toLowerCase(),
      path.resolve(harnessCase.installDirectory).toLowerCase(),
      `the uninstaller must resolve the real install directory; got ${JSON.stringify(resolution)}`,
    );
    assert.notEqual(
      path.resolve(exedir).toLowerCase(),
      path.resolve(harnessCase.installDirectory).toLowerCase(),
      `the uninstaller must not have run in place (that is what left the stub behind); got ${JSON.stringify(resolution)}`,
    );
    assert.equal(
      fs.existsSync(harnessCase.machineRoot),
      false,
      "the ProgramData machine tree must still be removed by the same run",
    );
  },
);

test(
  "the reinstall choice keeps the tree and never runs the uninstaller",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "reinstall");
    populateTree(harnessCase.machineRoot, "reinstall");
    const before = snapshotTree(harnessCase.machineRoot);
    installInnerUninstaller(harnessCase);
    const executable = writeChooser(harnessCase, "reinstall", {
      silent: true,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      sectionLines: [
        '  StrCpy $ytvwChoice "reinstall"',
        "  Call ytvwChooserLeave",
        '  FileOpen $0 "$EXEDIR\\after.txt" w',
        '  FileWrite $0 "after"',
        "  FileClose $0",
      ],
    });

    assert.equal(await runInstaller(executable, ["/S"]), 0);
    assert.equal(
      readMarker(harnessCase.directory, "after.txt"),
      "after",
      "the reinstall choice must fall through to the rest of the install",
    );
    assert.equal(
      readMarker(harnessCase.directory, "uninstaller-argv.log"),
      null,
      "the reinstall choice must not launch the uninstaller",
    );
    assert.deepEqual(
      snapshotTree(harnessCase.machineRoot),
      before,
      "the reinstall choice must leave the profile tree byte-identical",
    );
  },
);

test(
  "the cancel choice exits without touching the tree",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "cancel");
    populateTree(harnessCase.machineRoot, "cancel");
    const before = snapshotTree(harnessCase.machineRoot);
    installInnerUninstaller(harnessCase);
    const executable = writeChooser(harnessCase, "cancel", {
      silent: true,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      sectionLines: [
        '  StrCpy $ytvwChoice "cancel"',
        "  Call ytvwChooserLeave",
        '  FileOpen $0 "$EXEDIR\\after.txt" w',
        '  FileWrite $0 "after"',
        "  FileClose $0",
      ],
    });

    assert.equal(await runInstaller(executable, ["/S"]), 0);
    assert.equal(
      readMarker(harnessCase.directory, "after.txt"),
      null,
      "the cancel choice must exit before the section continues",
    );
    assert.equal(
      readMarker(harnessCase.directory, "uninstaller-argv.log"),
      null,
      "the cancel choice must not launch the uninstaller",
    );
    assert.deepEqual(
      snapshotTree(harnessCase.machineRoot),
      before,
      "the cancel choice must leave the tree byte-identical",
    );
  },
);

test(
  "a /S run never invokes the chooser page",
  { skip: skipReason },
  async (t) => {
    const harnessCase = createCase(t, "silent");
    const executable = writeChooser(harnessCase, "silent", {
      silent: true,
      detectionLines: [
        '!define YTVW_INSTALL_LOCATION "C:\\Program Files\\youtubetv-for-windows"',
      ],
      sectionLines: [
        // The create function is the only writer of `$ytvwInstalled`; an
        // empty read proves NSIS skipped the page callback entirely, so a
        // silent install can never be blocked by a prompt.
        '  FileOpen $0 "$EXEDIR\\installed.txt" w',
        "  FileWrite $0 $ytvwInstalled",
        "  FileClose $0",
        '  FileOpen $0 "$EXEDIR\\section.txt" w',
        '  FileWrite $0 "ran"',
        "  FileClose $0",
      ],
    });

    const exitCode = await runInstaller(executable, ["/S"], 15000);
    assert.equal(
      exitCode,
      0,
      "a silent install must complete without prompting",
    );
    assert.equal(
      readMarker(harnessCase.directory, "installed.txt"),
      "",
      "the silent run must not call the chooser page callback",
    );
    assert.equal(
      readMarker(harnessCase.directory, "section.txt"),
      "ran",
      "the silent install must still run the install section",
    );
  },
);

test(
  "the chooser compiles into the real assisted-UI page order at -WX",
  { skip: skipReason },
  (t) => {
    const harnessCase = createCase(t, "mui-order");
    const source = [
      "Unicode true",
      'Name "ytvw-chooser-mui"',
      'OutFile "mui.exe"',
      "SilentInstall silent",
      "RequestExecutionLevel user",
      `InstallDir "${harnessCase.installDirectory}"`,
      `!addplugindir /x86-unicode "${pluginDirectory}"`,
      "!define INSTALL_MODE_PER_ALL_USERS",
      "!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
      // No detection seam and no override: this is the real registry /
      // legacy-executable branch and the real MUI_HEADER_TEXT branch.
      '!define INSTALL_REGISTRY_KEY "Software\\ytvw-chooser-probe"',
      `!define APP_EXECUTABLE_FILENAME "${APP_EXE_NAME}"`,
      `!define UNINSTALL_FILENAME "${UNINSTALLER_NAME}"`,
      `!addincludedir "${buildDirectory}"`,
      '!include "nsis.include"',
      '!include "MUI2.nsh"',
      "!insertmacro MUI_PAGE_DIRECTORY",
      "!insertmacro customPageAfterChangeDir",
      "!insertmacro MUI_PAGE_INSTFILES",
      '!insertmacro MUI_LANGUAGE "English"',
      'Section "install"',
      "SectionEnd",
      "",
    ].join("\n");
    fs.writeFileSync(
      path.join(harnessCase.directory, "mui.nsi"),
      source,
      "utf8",
    );
    const { pages } = compile(harnessCase.directory, "mui.nsi");
    assert.ok(
      pages !== null && pages >= 3,
      `the custom page must sit between the directory and InstFiles pages in the real MUI order; got ${pages} pages`,
    );
  },
);
