// Todo-7 machine-data-root ACL suite.
//
// The app stores every Windows user's Chromium profile under a machine-wide
// root, and that root is created by the ELEVATED installer. A folder created
// by an elevated process is read-only for a standard user, so the installer
// must grant the local Users group modify itself. This suite drives the real
// `customInstall` hook through standalone makensis compiles and asserts the
// resulting ACL on disk - not the text of the macro.
//
// Every harness sets `InstallDir` and `$INSTDIR` to an empty scratch
// directory, so the compiled installer mirrors the real per-machine
// condition.
//
// `$SYSDIR\icacls.exe` is the correct tool path. In NSIS 3 $SYSDIR is a
// COMPILE-TIME CONSTANT holding the Windows SYSTEM directory
// (C:\WINDOWS\system32): it is independent of $INSTDIR and is not moved by
// `InstallDir` nor by `SetOutPath $INSTDIR` (installSection.nsh:60).
// electron-builder's own allowOnlyOneInstallerInstance.nsh resolves
// cmd.exe, findstr.exe, and powershell.exe through $SYSDIR for the same
// reason. The suite's value is therefore not that it finds the tool, but
// that it asserts the resolved path EXISTS instead of trusting the
// register's name.
//
// Covered:
//   - the real define set compiles under -WX (electron-builder passes
//     warningsAsErrors), including the path with no `YTVW_*` override at all;
//   - the hook creates the root and leaves the local Users group a
//     non-inherited `(OI)(CI)` grant on it whose DECODED access mask is
//     exactly the Modify set plus FILE_DELETE_CHILD, and carries neither
//     WRITE_DAC nor WRITE_OWNER nor GENERIC_ALL;
//   - a non-directory root, a failing grant, and a missing ProgramData each
//     abort the install (a silent install exits nonzero) instead of
//     continuing with an unusable or drive-relative path.
//
// WHAT THE GRANT IS, AND WHAT IT IS NOT - the honest version.
//
// The grant exists so a standard user can CREATE `users\<key>\profile` and
// `userdata` under a root the ELEVATED installer created. On this machine that
// ability does not come from the data root's own DACL; it comes from the DACL
// C:\ProgramData hands down by inheritance. The explicit grant makes the app's
// write access a property of the data root's OWN DACL rather than an
// inheritance accident, so the app still works on a machine whose ProgramData
// Users entries are reduced or removed.
//
// Naming ONE inherited ACE as the cause would be wrong, and this file used to
// do it. C:\ProgramData carries two Users ACEs that pull opposite ways: an
// ALLOW of 0x1200A9 (read + execute) and a DENY of 0x1015F that covers DELETE,
// FILE_DELETE_CHILD, FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_ATTRIBUTES,
// FILE_READ_DATA, FILE_WRITE_EA and FILE_READ_EA. A DENY is evaluated before any
// ALLOW, so the 0x116 reading of icacls's `(CI)(WD,AD,WEA,WA)` cannot be the
// explanation. What the created object actually shows is Windows resolving the
// inherited CREATOR OWNER ACE to the creating user's own SID, written in as
// GENERIC_ALL for that user alone. What is load-bearing for the grant is the
// measured net effect, not any single inherited ACE: with inheritance intact
// and no grant a Medium token can create its own subtree; with every Users ACE
// removed it cannot create anything (EPERM).
//
// It is NOT a behavioural fix for a measured failure, and this suite must not be
// read as one. Measured, with a retained instrument and a grant-absent control
// on a tree carrying the installed tree's real shape and ACL
// (release-evidence/installer-mode/todo13-real/run-20260930-221942-acl-grant-control/01-grant-absent-control.log):
// a Medium-integrity token with NO Users grant completes 11 of the 12 disputed
// operations, and the 12th (single-call removal of a NON-EMPTY directory) fails
// with ENOTEMPTY under the grant too, because NTFS refuses a non-empty
// directory regardless of the caller's rights. FILE_DELETE_CHILD is therefore
// NOT behaviourally required for any operation the app performs. Every object
// the app writes is app-created, and an inherited CREATOR OWNER ACE already
// authorises what a token created itself.
//
// Consequently this suite asserts the MASK and never a behavioural necessity for
// any individual right. The exact-mask assertion below subsumes the separate
// delete-child bit check, so removing that check does not weaken the suite.

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

// The grant target. The local Users group is addressed by SID, not by name,
// so the assertion does not depend on the machine's locale.
const USERS_SID_ALIASES = ["BU", "S-1-5-32-545"];

// The suite asserts on the DECODED NUMERIC access mask rather than on icacls's
// printed letters, because the printed letters are exactly what hid the
// defect: icacls renders the Modify set as the single token `(M)`, and the
// letters cannot show that FILE_DELETE_CHILD is missing from it.
//
// Both numbers below were MEASURED on this machine by decoding the SDDL of a
// real `icacls /grant` (see
// release-evidence/installer-mode/todo13-real/run-20260930-194510-acl-delete-child/01-icacls-syntax-measurement-temp.log):
//
//   icacls /grant *S-1-5-32-545:(OI)(CI)M           -> 0x1301BF
//   icacls /grant *S-1-5-32-545:(OI)(CI)(...,DC,..) -> 0x1301FF
//   icacls /grant *S-1-5-32-545:(OI)(CI)F           -> 0x1F01FF
//
// 0x1301BF is 0x1FF minus 0x40, so the pre-change grant did NOT include
// FILE_DELETE_CHILD. 0x1301FF is 0x1301BF plus exactly 0x40. 0x1F01FF is the
// full-access mask and carries WRITE_DAC and WRITE_OWNER, which is why the
// grant must never be widened to the simple right `F`.
//
// The three numbers are assertions about the GRANT, not about what the app can
// do. FILE_DELETE_CHILD's presence is not behaviourally load-bearing; see the
// header note above and the measured evidence it cites. The numbers stay pinned
// because the grant is specified as Modify named bit by bit, and that is a
// stronger property than any single right's necessity.
const MODIFY_MASK = 0x1301bf;
const FILE_DELETE_CHILD = 0x00000040;
const WRITE_DAC = 0x00040000;
const WRITE_OWNER = 0x00080000;
const GENERIC_ALL = 0x10000000;

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
//   BUILTIN\Users:(OI)(CI)(M,DC)
// The leading (I) on an inherited entry is what tells the two apart, so the
// pattern is anchored on the whole entry rather than a substring search.
//
// The printed form is kept as a SECONDARY check only. The authoritative
// assertion is the decoded numeric mask below, because `(M)` and `(M,DC)` look
// almost the same and only the decode settles whether delete-child is there.
const usersGrantPattern = new RegExp(
  "^(?:BUILTIN\\\\Users|\\*S-1-5-32-545):\\(OI\\)\\(CI\\)\\(M,DC\\)$",
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

// SDDL writes a numeric access mask with a "0x" prefix but writes an
// all-access ACE as the symbolic token "FA" - and "FA" is also a valid hex
// string, so the prefix and the symbolic table are both tested BEFORE hex or
// an all-access ACE silently decodes as 0x000000FA.
const SDDL_SYMBOLIC_RIGHTS = { FA: 0x1f01ff, FR: 0x1200a9, FW: 0x120116 };

function readSddl(target) {
  const result = spawnSync(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Acl -LiteralPath '${target.replace(/'/g, "''")}').Sddl`,
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `Get-Acl failed on ${target}: ${result.stderr}`,
  );
  const sddl = result.stdout.trim();
  assert.notEqual(sddl, "", `Get-Acl returned an empty SDDL for ${target}`);
  return sddl;
}

// An SDDL ACE is `type;flags;rights;objectType;inheritedObjectType;SID`.
function parseAces(sddl) {
  const start = sddl.indexOf("(");
  assert.notEqual(start, -1, `no DACL in SDDL: ${sddl}`);
  return (sddl.slice(start).match(/\(([^)]*)\)/g) ?? []).map((ace) =>
    ace.slice(1, -1).split(";"),
  );
}

function rightsTokenToMask(rights) {
  if (/^0x[0-9a-fA-F]+$/.test(rights)) {
    return parseInt(rights.slice(2), 16) >>> 0;
  }
  const symbolic = SDDL_SYMBOLIC_RIGHTS[rights.toUpperCase()];
  if (symbolic !== undefined) {
    return symbolic;
  }
  if (/^[0-9a-fA-F]+$/.test(rights)) {
    return parseInt(rights, 16) >>> 0;
  }
  return null;
}

// The granted (non-inherited) Users ACE, with its access mask resolved to the
// file-specific bits the object manager enforces. Returns null when there is
// no such ACE, so the caller can fail with a readable message.
function readGrantedUsersAce(target) {
  const sddl = readSddl(target);
  for (const [type, flags, rights, , , sid] of parseAces(sddl)) {
    if (type !== "A" || !USERS_SID_ALIASES.includes(sid)) {
      continue;
    }
    // An INHERITED ACE carries the "ID" flag. The inheritance flags "OI" and
    // "CI" also contain the letter I, so testing for a bare "I" would reject
    // every granted ACE as well as the inherited ones.
    if (flags.includes("ID")) {
      continue;
    }
    let mask = rightsTokenToMask(rights);
    if (mask === null) {
      continue;
    }
    // Resolve any generic bit the ACE carries to the file-specific bits it
    // maps to, so a GENERIC_* grant cannot hide inside the mask.
    if (flags.includes("GA")) {
      mask |= 0x1f01ff;
    }
    if (flags.includes("GW")) {
      mask |= 0x120116;
    }
    if (flags.includes("GR")) {
      mask |= 0x120089;
    }
    if (flags.includes("GX")) {
      mask |= 0x1200a0;
    }
    return {
      sddl,
      flags,
      rights,
      mask,
      ace: `${type};${flags};${rights};;;${sid}`,
    };
  }
  return { sddl, ace: null, mask: null, flags: null, rights: null };
}

function hex(mask) {
  return `0x${mask.toString(16).toUpperCase()}`;
}

function assertUsersDeleteChildGrant(target) {
  const ace = readGrantedUsersAce(target);
  assert.notEqual(
    ace.mask,
    null,
    `the local Users group must hold a non-inherited grant on ${target}; ` +
      `SDDL: ${ace.sddl}`,
  );
  assert.ok(
    ace.flags.includes("OI") && ace.flags.includes("CI"),
    `the Users grant must inherit to objects and containers so the whole tree ` +
      `is writable; flags "${ace.flags}" on ${target}`,
  );

  // The pre-change grant was 0x1301BF, which is exactly Modify minus
  // FILE_DELETE_CHILD. Asserting the superset relationship keeps every right
  // the Modify grant gave (create, write, read, delete, attributes) while
  // requiring delete-child on top.
  const missing = MODIFY_MASK & ~ace.mask;
  assert.equal(
    missing,
    0,
    `the Users grant must be a superset of the Modify set ${hex(
      MODIFY_MASK,
    )}; granted ${hex(ace.mask)} is missing ${hex(missing)} on ${target}`,
  );

  // There is deliberately NO separate "FILE_DELETE_CHILD must be granted or a
  // standard user cannot X" assertion. That claim was measured and refuted: with
  // no Users grant at all, a Medium-integrity token still completes 11 of the
  // same 12 operations, because every object the app creates is owned by the app
  // itself through the inherited CREATOR OWNER ACE, and the twelfth (single-call
  // removal of a NON-EMPTY directory) fails with ENOTEMPTY under the grant too.
  // Asserting the bit with a behavioural reason would enshrine a claim that
  // measurement contradicts, and a test that asserts something untrue is worse
  // than no test.
  //
  // The bit is still pinned, and this suite is NOT weakened by its absence: the
  // exact-mask assertion a few lines below requires
  // `ace.mask === MODIFY_MASK | FILE_DELETE_CHILD`, which STRICTLY IMPLIES
  // `ace.mask & FILE_DELETE_CHILD !== 0`. The mask assertion is the stronger
  // claim, and it is correct.

  for (const [bit, name] of [
    [WRITE_DAC, "WRITE_DAC"],
    [WRITE_OWNER, "WRITE_OWNER"],
    [GENERIC_ALL, "GENERIC_ALL"],
  ]) {
    assert.equal(
      (ace.mask & bit) === 0,
      true,
      `the Users grant must NOT include ${name} (${hex(bit)}): a standard ` +
        `user holding it could rewrite the permissions on the data root; ` +
        `granted mask ${hex(ace.mask)} on ${target} from ACE (${ace.ace})`,
    );
  }

  // The exact mask is pinned so a later widening (the simple right `F` decodes
  // to 0x1F01FF) fails here rather than passing the subset checks above.
  assert.equal(
    ace.mask,
    MODIFY_MASK | FILE_DELETE_CHILD,
    `the Users grant must be exactly Modify plus delete-child ` +
      `(${hex(MODIFY_MASK | FILE_DELETE_CHILD)}); granted ${hex(ace.mask)} on ` +
      `${target} from ACE (${ace.ace})`,
  );

  // Secondary, text-level: icacls's own re-render of the granted set. This is
  // the shape a human reads in a bug report, so it is pinned too - but on its
  // own it could not have caught the original defect.
  const entries = readAclEntries(target);
  assert.ok(
    entries.some((line) => usersGrantPattern.test(line)),
    `icacls must re-render the Users grant as "(OI)(CI)(M,DC)"; got:\n${entries.join("\n")}`,
  );
  return ace;
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
  "the install hook creates the machine root and grants the Users group modify plus delete-child",
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
    const ace = assertUsersDeleteChildGrant(machineRoot);
    t.diagnostic(
      `Users grant on the machine root: ACE (${ace.ace}) decoded ${hex(ace.mask)} ` +
        `= ${hex(MODIFY_MASK)} (Modify) | 0x${FILE_DELETE_CHILD.toString(16)} (FILE_DELETE_CHILD); ` +
        `WRITE_DAC clear, WRITE_OWNER clear, GENERIC_ALL clear`,
    );
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
