// Todo-7 machine-data-root ACL suite.
//
// The app stores every Windows user's Chromium profile under a machine-wide
// root, and that root is created by the ELEVATED installer. A folder created
// by an elevated process is read-only for a standard user, so the installer
// must grant the local Users group modify itself. This suite drives the real
// `customInstall` hook through standalone makensis compiles and asserts the
// resulting ACL on disk - not the text of the macro.
//
// Every harness sets `InstallDir` to an empty scratch directory, which is the
// production condition: in a real per-machine build $SYSDIR is the install
// directory (`$PROGRAMFILES64\youtubetv-for-windows`) and ships no icacls.exe.
// A harness without `InstallDir` silently defaults $SYSDIR to the system
// directory, so resolving the tool from $SYSDIR would pass here and abort on
// every real machine. Fixing InstallDir is what makes this suite able to see
// that class of bug.
//
// Covered:
//   - the real define set compiles under -WX (electron-builder passes
//     warningsAsErrors), including the path with no `YTVW_*` override at all;
//   - the hook creates the root and leaves the local Users group a
//     non-inherited `(OI)(CI)(M)` grant on it;
//   - a non-directory root, a failing grant, and a missing ProgramData each
//     abort the install (a silent install exits nonzero) instead of
//     continuing with an unusable or drive-relative path.

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
const machineDirName = "youtubetv-for-windows";

// NSIS's default user group for the grant. icacls renders it as the
// well-known English name, but the SID form is accepted too so the assertion
// does not depend on the machine's locale.
const USERS_GRANT = "(OI)(CI)(M)";

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

// nsExec.dll lives in the makensis distribution, not in the
// nsis-resources plugin directory (which only carries the builder's own
// StdUtils plugin). Without !addplugindir the plugin call is resolved by
// whatever happens to sit next to the harness, which is not a real build.
function findNsExecPluginDirectory() {
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
    for (const inner of fs.readdirSync(path.join(cacheRoot, entry))) {
      const candidate = path.join(
        cacheRoot,
        entry,
        inner,
        "Plugins",
        "x86-unicode",
        "nsExec.dll",
      );
      if (fs.existsSync(candidate)) {
        return path.dirname(candidate);
      }
    }
  }
  return null;
}

const makensisPath = findMakensis();
const pluginDirectory = findNsExecPluginDirectory();
const skipReason =
  makensisPath === null || pluginDirectory === null
    ? "makensis.exe or the cached nsExec.dll plugin directory was not found " +
      "(electron-builder NSIS cache empty); run a bounded package build to " +
      "populate %LOCALAPPDATA%\\electron-builder\\Cache\\nsis-*"
    : false;

function createCase(t, name) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-dataroot-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// Every harness replays the two install-section facts that decide where the
// installer looks for icacls.exe, and records what it saw.
//
// In NSIS 3 $SYSDIR is a COMPILE-TIME CONSTANT holding the Windows SYSTEM
// directory (C:\WINDOWS\system32) - not $INSTDIR, and not the per-machine
// install tree. `StrCpy $SYSDIR` fails to compile ("cannot change constants")
// and `SetOutPath $INSTDIR`, which the real template runs at
// installSection.nsh:60, does not move it. That is why "$SYSDIR\icacls.exe"
// resolves to the one directory that always holds icacls.exe even though
// nothing ships it into the install directory - and why the happy-path test
// asserts the tool path exists instead of trusting the register's name.
//
// $INSTDIR is set explicitly first because `InstallDir` alone leaves it unset
// in a silent install, which would not match the per-machine root
// multiUser.nsh assigns in .onInit.
function harnessSource(installDirectory, defines) {
  return [
    "Unicode true",
    'Name "ytvw-dataroot"',
    'OutFile "ytvw-dataroot.exe"',
    "SilentInstall silent",
    "RequestExecutionLevel user",
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    "!define INSTALL_MODE_PER_ALL_USERS",
    "!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
    `!addplugindir /x86-unicode "${pluginDirectory ?? ""}"`,
    ...defines,
    `!addincludedir "${path.dirname(includePath)}"`,
    '!include "nsis.include"',
    'Section "install"',
    `  StrCpy $INSTDIR "${installDirectory}"`,
    "  SetOutPath $INSTDIR",
    '  FileOpen $8 "$EXEDIR\\sysdir.txt" w',
    "  FileWrite $8 $SYSDIR",
    "  FileClose $8",
    "  !insertmacro customInstall",
    "SectionEnd",
    "",
  ].join("\n");
}

// The $SYSDIR the harness actually ran with, as the installer saw it.
function recordedSysDir(directory) {
  return fs.readFileSync(path.join(directory, "sysdir.txt"), "utf8").trim();
}

function compile(directory, name) {
  const result = spawnSync(makensisPath, ["-WX", name], {
    cwd: directory,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function runSilent(directory, extraEnv) {
  const env = { ...process.env };
  delete env.ProgramData;
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(directory, "ytvw-dataroot.exe"), ["/S"], {
      windowsHide: true,
      stdio: "ignore",
      env,
    });
    const timer = setTimeout(() => {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      reject(new Error("the harness installer did not exit within 30s"));
    }, 30000);
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

// The machine root is always <machineRootBase>\youtubetv-for-windows.
function machineRootOf(base) {
  return path.join(base, machineDirName);
}

// icacls prints one ACE per line, prefixed by the file name on the FIRST line
// only, so that prefix has to come off before the entries can be compared. A
// granted (not inherited) Users entry then looks like:
//   BUILTIN\Users:(OI)(CI)(M)
// The leading (I) on an inherited entry is what tells the two apart, so the
// pattern is anchored on the whole entry rather than a substring search.
const usersGrantPattern = new RegExp(
  "^(?:BUILTIN\\\\Users|\\*S-1-5-32-545):\\(OI\\)\\(CI\\)\\(M\\)$",
);

function readAclEntries(target) {
  const result = spawnSync(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "icacls.exe",
    ),
    [target],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `icacls failed on ${target}: ${result.stderr}`,
  );
  const prefix = `${target} `;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) =>
      index === 0 && line.startsWith(prefix)
        ? line.slice(prefix.length).trim()
        : line,
    );
}

function assertUsersModifyGrant(target) {
  const entries = readAclEntries(target);
  assert.ok(
    entries.some((line) => usersGrantPattern.test(line)),
    `the local Users group must hold a non-inherited ${USERS_GRANT} grant on ${target}; got:\n${entries.join("\n")}`,
  );
}

test(
  "the install hook compiles with the real define set and no override",
  { skip: skipReason },
  (t) => {
    const directory = createCase(t, "compile");
    const installDirectory = path.join(directory, "install");
    fs.mkdirSync(installDirectory);
    // No YTVW_MACHINE_ROOT and no YTVW_ICACLS: exactly the branches the real
    // electron-builder build takes, so a -WX failure here is a build failure.
    fs.writeFileSync(
      path.join(directory, "default.nsi"),
      harnessSource(installDirectory, []),
      "utf8",
    );
    const compiled = compile(directory, "default.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
    assert.ok(
      !/warning/i.test(compiled.output),
      `-WX must emit no warnings: ${compiled.output.slice(-800)}`,
    );
  },
);

test(
  "the install hook creates the machine root and grants the Users group modify",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "grant");
    const installDirectory = path.join(directory, "install");
    fs.mkdirSync(installDirectory);
    const machineRootBase = path.join(directory, "machine-root-base");
    fs.writeFileSync(
      path.join(directory, "grant.nsi"),
      harnessSource(installDirectory, [
        `!define YTVW_MACHINE_ROOT "${machineRootBase}"`,
      ]),
      "utf8",
    );
    const compiled = compile(directory, "grant.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));

    assert.equal(await runSilent(directory), 0);
    // The grant runs "$SYSDIR\icacls.exe", and nothing ships icacls.exe into
    // the install tree, so the install only works because $SYSDIR is the
    // Windows system directory. Assert the tool path that will actually be
    // executed rather than trusting the register's name.
    const icaclsPath = path.join(recordedSysDir(directory), "icacls.exe");
    assert.ok(
      fs.existsSync(icaclsPath),
      `the grant's icacls path must exist on this machine: ${icaclsPath}`,
    );
    assert.equal(
      fs.existsSync(path.join(installDirectory, "icacls.exe")),
      false,
      "the harness install directory must stay free of an icacls.exe, or it " +
        "would mask a grant path that is wrong in a real install",
    );
    const machineRoot = machineRootOf(machineRootBase);
    assert.ok(
      fs.statSync(machineRoot).isDirectory(),
      `the machine root must exist: ${machineRoot}`,
    );
    assertUsersModifyGrant(machineRoot);
  },
);

test(
  "a file where the machine root belongs aborts the install",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "non-directory");
    const installDirectory = path.join(directory, "install");
    fs.mkdirSync(installDirectory);
    const machineRootBase = path.join(directory, "machine-root-base");
    // icacls /C walks past a missing or unusable path and still exits 0, so
    // the create step is the only thing that can catch this.
    fs.mkdirSync(machineRootBase, { recursive: true });
    fs.writeFileSync(machineRootOf(machineRootBase), "not a directory");
    fs.writeFileSync(
      path.join(directory, "blocker.nsi"),
      harnessSource(installDirectory, [
        `!define YTVW_MACHINE_ROOT "${machineRootBase}"`,
      ]),
      "utf8",
    );
    const compiled = compile(directory, "blocker.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));

    assert.notEqual(
      await runSilent(directory),
      0,
      "an install that cannot create the machine root must not report success",
    );
    assert.equal(
      fs.statSync(machineRootOf(machineRootBase)).isFile(),
      true,
      "the blocking file must be left exactly as it was",
    );
  },
);

// Every grant failure has to abort, and there are two distinct shapes of it:
// the tool cannot be launched at all (nsExec returns the string "error"), and
// the tool runs and reports failure (nsExec returns its nonzero exit code).
// Both are measured rather than assumed, so neither premise is a guess.
const grantFailureStubs = [
  {
    label: "a grant tool that cannot be launched aborts the install",
    stub: (directory) => path.join(directory, "no-such-tool.exe"),
    because:
      "an absent icacls.exe is the failure an elevated install hits when the " +
      'tool path is wrong; nsExec returns the string "error", not a number',
  },
  {
    label: "a grant that returns a nonzero exit code aborts the install",
    stub: () =>
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "findstr.exe",
      ),
    because:
      "findstr treats every argument as a pattern and no input files as a " +
      "search, so it returns 1 for this argument list - a real executable " +
      "reporting a real failure, without depending on how a shell parses it",
  },
];

for (const { label, stub, because } of grantFailureStubs) {
  test(label, { skip: skipReason }, async (t) => {
    const directory = createCase(t, "grant-failure");
    const installDirectory = path.join(directory, "install");
    fs.mkdirSync(installDirectory);
    const machineRootBase = path.join(directory, "machine-root-base");
    fs.writeFileSync(
      path.join(directory, "failing.nsi"),
      harnessSource(installDirectory, [
        `!define YTVW_MACHINE_ROOT "${machineRootBase}"`,
        `!define YTVW_ICACLS "${stub(directory)}"`,
      ]),
      "utf8",
    );
    const compiled = compile(directory, "failing.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));

    assert.notEqual(
      await runSilent(directory),
      0,
      `a failing grant must abort the install; ${because}`,
    );
  });
}

test(
  "a missing ProgramData aborts the install instead of granting a relative path",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "no-programdata");
    const installDirectory = path.join(directory, "install");
    fs.mkdirSync(installDirectory);
    // Neither override: the hook reads %ProgramData% from the environment,
    // which runSilent() removes. A blank root would turn both the create and
    // the grant into a drive-relative path.
    fs.writeFileSync(
      path.join(directory, "blank.nsi"),
      harnessSource(installDirectory, []),
      "utf8",
    );
    const compiled = compile(directory, "blank.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));

    assert.notEqual(
      await runSilent(directory),
      0,
      "a missing ProgramData must abort the install, not continue",
    );
    assert.equal(
      fs.existsSync(path.join(path.parse(directory).root, machineDirName)),
      false,
      "the install must never create a drive-relative machine root",
    );
  },
);
