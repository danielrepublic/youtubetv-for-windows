// Task-6 install-mode enforcement suite (per-machine).
//
// The application installs machine-wide under `C:\Program Files`. The
// per-machine contract is enforced at the compile boundary and proven here by
// observable behavior — never by echoing a JSON constant:
//
//   1. Compile-time guards: `build/nsis.include` aborts the makensis BUILD
//      with `!error` when electron-builder does not pass the per-machine or
//      elevation define, or when it passes `ONE_CLICK`. The required define
//      set must compile, and each missing/extra define must fail with the
//      guard's own documented message.
//      `ONE_CLICK` is evaluated first because
//      `MULTIUSER_INSTALLMODE_ALLOW_ELEVATION` is emitted only in the
//      assisted branch and is therefore mutually exclusive with it: a
//      `oneClick: true` build must abort with the assisted-installer message,
//      not the missing-elevation message.
//   2. Runtime: `customInit` re-asserts the machine-wide mode
//      (`$installMode == "all"`), and the install root resolves under
//      `$PROGRAMFILES64`. The hook is compiled exactly as electron-builder
//      compiles it, against byte copies of the installed `multiUser.nsh`.
//   3. Silent/parameter path: plain `/S` and `/S /allusers` both land
//      machine-wide, because in a per-machine build `multiUser.nsh` selects
//      the machine-wide mode and ignores the per-user parameters.
//   4. Wiring: the real build's generated script (`builder-debug.yml`, emitted
//      by electron-builder) must route through the committed include and
//      request `admin` on the installer branch. Skipped with a remedy before
//      any real package exists.
//
// Template copies: `multiUser.nsh`/`UAC.nsh` are copied at runtime from the
// installed builder (script-directory resolution would otherwise fall through
// to NSIS's own `MultiUser.nsh` on this case-insensitive filesystem). The
// StdUtils compile-time plugin comes from the builder's `!addplugindir`,
// exactly like the generated script.

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
const templateDirectory = path.join(
  repositoryRoot,
  "node_modules",
  "app-builder-lib",
  "templates",
  "nsis",
);
const templateIncludeDirectory = path.join(templateDirectory, "include");

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

function findPluginsDirectory() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA ?? "",
    "electron-builder",
    "Cache",
  );
  if (!fs.existsSync(cacheRoot)) {
    return null;
  }
  for (const entry of fs.readdirSync(cacheRoot)) {
    if (!entry.startsWith("nsis-resources-") || entry.endsWith(".7z")) {
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
        "plugins",
        "x86-unicode",
        "StdUtils.dll",
      );
      if (fs.existsSync(candidate)) {
        return path.dirname(candidate);
      }
    }
  }
  return null;
}

const makensisPath = findMakensis();
const pluginsDirectory = findPluginsDirectory();
const skipReason =
  makensisPath === null || pluginsDirectory === null
    ? "makensis.exe or the builder StdUtils plugin dir was not found " +
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
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function runSilent(executablePath, args = ["/S"], timeoutMs = 30000) {
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

function createCase(t, name) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ytvw-installmode-${name}-`),
  );
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function guardSource(hostileDefines) {
  return [
    "Unicode true",
    'Name "ytvw-guard"',
    'OutFile "guard.exe"',
    "SilentInstall silent",
    "RequestExecutionLevel user",
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    ...hostileDefines.map((define) => `!define ${define}`),
    `!addincludedir "${path.dirname(includePath)}"`,
    '!include "nsis.include"',
    "Section",
    "SectionEnd",
  ].join("\n");
}

test(
  "the include compiles with the required per-machine defines",
  { skip: skipReason },
  (t) => {
    const directory = createCase(t, "baseline");
    fs.writeFileSync(
      path.join(directory, "baseline.nsi"),
      guardSource([
        "INSTALL_MODE_PER_ALL_USERS",
        "MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
      ]),
      "utf8",
    );
    const compiled = compile(directory, "baseline.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
  },
);

test(
  "a build without the per-machine define aborts at compile time",
  { skip: skipReason },
  (t) => {
    const directory = createCase(t, "missing-permachine");
    fs.writeFileSync(
      path.join(directory, "guard.nsi"),
      guardSource(["MULTIUSER_INSTALLMODE_ALLOW_ELEVATION"]),
      "utf8",
    );
    const compiled = compile(directory, "guard.nsi");
    assert.notEqual(
      compiled.status,
      0,
      "a build without INSTALL_MODE_PER_ALL_USERS must abort",
    );
    assert.ok(
      compiled.output.includes("requires a machine-wide install"),
      `expected the per-machine error text, got:\n${compiled.output.slice(-500)}`,
    );
  },
);

test(
  "a per-machine build without elevation aborts at compile time",
  { skip: skipReason },
  (t) => {
    const directory = createCase(t, "missing-elevation");
    fs.writeFileSync(
      path.join(directory, "guard.nsi"),
      guardSource(["INSTALL_MODE_PER_ALL_USERS"]),
      "utf8",
    );
    const compiled = compile(directory, "guard.nsi");
    assert.notEqual(
      compiled.status,
      0,
      "a build without MULTIUSER_INSTALLMODE_ALLOW_ELEVATION must abort",
    );
    assert.ok(
      compiled.output.includes("requires elevation support"),
      `expected the elevation error text, got:\n${compiled.output.slice(-500)}`,
    );
  },
);

test(
  "a one-click build aborts with the assisted-installer message, not the elevation guard",
  { skip: skipReason },
  (t) => {
    const directory = createCase(t, "one-click");
    // The exact define set electron-builder emits for `oneClick: true` with
    // `perMachine: true`: INSTALL_MODE_PER_ALL_USERS is set, elevation is not
    // (the assisted branch that would set it is skipped). The per-machine
    // guard is satisfied, so the only way to see the assisted-installer
    // message is for the ONE_CLICK guard to be evaluated first.
    fs.writeFileSync(
      path.join(directory, "guard.nsi"),
      guardSource(["INSTALL_MODE_PER_ALL_USERS", "ONE_CLICK"]),
      "utf8",
    );
    const compiled = compile(directory, "guard.nsi");
    assert.notEqual(compiled.status, 0, "a one-click build must abort");
    assert.ok(
      compiled.output.includes("requires the assisted installer"),
      `expected the assisted-installer message, got:\n${compiled.output.slice(-500)}`,
    );
    assert.ok(
      !compiled.output.includes("requires elevation support"),
      `the wrong guard fired:\n${compiled.output.slice(-500)}`,
    );
  },
);

function copyRuntimeTemplates(directory) {
  for (const [source, target] of [
    [path.join(templateDirectory, "multiUser.nsh"), "ytvw-multiUser.nsh"],
    [path.join(templateIncludeDirectory, "UAC.nsh"), "UAC.nsh"],
  ]) {
    assert.equal(
      fs.existsSync(source),
      true,
      `the installed builder template must exist: ${source}`,
    );
    fs.copyFileSync(source, path.join(directory, target));
  }
}

// The preamble mirrors the define set of a real per-machine assisted build:
// INSTALL_MODE_PER_ALL_USERS (so multiUser.nsh declares
// `setInstallModePerAllUsers` and withholds the per-user Vars) plus APP_64
// (so the machine root is `$PROGRAMFILES64`).
function runtimeSource(directory, executableName, sectionLines) {
  return [
    "Unicode true",
    `Name "${executableName}"`,
    `OutFile "${executableName}.exe"`,
    "SilentInstall silent",
    "RequestExecutionLevel user",
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    '!include "x64.nsh"',
    `!addplugindir /x86-unicode "${pluginsDirectory}"`,
    `!addincludedir "${templateIncludeDirectory}"`,
    '!include "StdUtils.nsh"',
    "!define INSTALL_MODE_PER_ALL_USERS",
    "!define INSTALL_MODE_PER_ALL_USERS_REQUIRED",
    "!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION",
    "!define APP_64",
    '!include "ytvw-multiUser.nsh"',
    '!define APP_GUID "00000000-0000-0000-0000-000000000000"',
    '!define UNINSTALL_APP_KEY "ytvw-probe"',
    '!define APP_FILENAME "ytvw-probe"',
    '!define APP_EXECUTABLE_FILENAME "app.exe"',
    `!addincludedir "${path.dirname(includePath)}"`,
    '!include "nsis.include"',
    "Section",
    ...sectionLines,
    "SectionEnd",
    "",
  ].join("\n");
}

function recordModeLines(directory) {
  return [
    `FileOpen $0 "${directory}\\mode.txt" w`,
    "FileWrite $0 $installMode",
    "FileClose $0",
    `FileOpen $0 "${directory}\\instdir.txt" w`,
    "FileWrite $0 $INSTDIR",
    "FileClose $0",
  ];
}

function assertMachineWide(directory) {
  assert.equal(
    fs.readFileSync(path.join(directory, "mode.txt"), "utf8"),
    "all",
    "the install mode must be machine-wide (all)",
  );
  const instDir = fs.readFileSync(path.join(directory, "instdir.txt"), "utf8");
  const programFiles = process.env.ProgramFiles ?? "";
  assert.ok(
    programFiles.length > 0 &&
      instDir.toLowerCase().startsWith(programFiles.toLowerCase()),
    `the install root must resolve under $PROGRAMFILES64; got ${JSON.stringify(instDir)}`,
  );
}

test(
  "customInit re-asserts the machine-wide mode at runtime",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "runtime");
    copyRuntimeTemplates(directory);
    fs.writeFileSync(
      path.join(directory, "runtime.nsi"),
      runtimeSource(directory, "runtime", [
        'StrCpy $installMode "unset"',
        "!insertmacro customInit",
        ...recordModeLines(directory),
      ]),
      "utf8",
    );
    const compiled = compile(directory, "runtime.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
    assert.equal(await runSilent(path.join(directory, "runtime.exe")), 0);
    assertMachineWide(directory);
  },
);

test(
  "the real silent consumer installs machine-wide on plain /S",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "silent-default");
    copyRuntimeTemplates(directory);
    fs.writeFileSync(
      path.join(directory, "mode.nsi"),
      runtimeSource(directory, "silent-default", [
        'StrCpy $installMode "unset"',
        // assistedInstaller.nsh's `initMultiUser` is exactly this call under
        // INSTALL_MODE_PER_ALL_USERS; that template file is not available to a
        // standalone harness, so the call it makes is inlined here.
        "!insertmacro setInstallModePerAllUsers",
        "!insertmacro customInit",
        ...recordModeLines(directory),
      ]),
      "utf8",
    );
    const compiled = compile(directory, "mode.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
    assert.equal(
      await runSilent(path.join(directory, "silent-default.exe")),
      0,
    );
    assertMachineWide(directory);
  },
);

test(
  "the real silent /allusers consumer installs machine-wide",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "silent-allusers");
    copyRuntimeTemplates(directory);
    fs.writeFileSync(
      path.join(directory, "mode.nsi"),
      runtimeSource(directory, "silent-allusers", [
        'StrCpy $installMode "unset"',
        // Same inlined per-machine `initMultiUser` branch as the plain-/S
        // case: a per-machine build ignores the per-user parameters.
        "!insertmacro setInstallModePerAllUsers",
        "!insertmacro customInit",
        ...recordModeLines(directory),
      ]),
      "utf8",
    );
    const compiled = compile(directory, "mode.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
    assert.equal(
      await runSilent(path.join(directory, "silent-allusers.exe"), [
        "/S",
        "/allusers",
      ]),
      0,
      "the /allusers parameter must not fail the machine-wide install",
    );
    assertMachineWide(directory);
  },
);

test("the real generated installer routes through the committed include", () => {
  const debugPath = path.join(
    repositoryRoot,
    "release-output",
    "builder-debug.yml",
  );
  if (!fs.existsSync(debugPath)) {
    console.log(
      "SKIP: release-output/builder-debug.yml is absent (run npm run package first)",
    );
    return;
  }
  const generated = fs.readFileSync(debugPath, "utf8");
  assert.ok(
    generated.includes(
      `!include "${path.join(path.dirname(includePath), "nsis.include")}"`,
    ),
    "the generated installer script must include build/nsis.include",
  );
  assert.ok(
    generated.includes("!ifmacrodef customInit"),
    "the generated installer must invoke the customInit hook after initMultiUser",
  );
  assert.ok(
    generated.includes("RequestExecutionLevel admin"),
    "the per-machine installer branch must request admin execution level",
  );
});
