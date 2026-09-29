// Task-7 install-mode enforcement suite.
//
// The reviewer blocker: `oneClick:false` + `perMachine:false` alone still
// leaves the assisted install-mode page and elevation available. The fix is
// a three-layer enforcement, and every layer is proven here by observable
// behavior — never by echoing a JSON constant:
//
//   1. Compile-time guards: `build/nsis.include` aborts the makensis BUILD
//      with `!error` when electron-builder passes a per-machine, elevating,
//      or one-click define. Each hostile define is compiled against the real
//      include and must fail with the documented message.
//   2. Interactive path: the `customInstallMode` hook sets
//      `$isForceCurrentInstall`, which makes the template's mode page select
//      per-user and skip itself. Proven at runtime with a marker.
//   3. Silent/update path (no page is ever shown): the exact downstream
//      consumer copied from `installer.nsi:99-121` must see the restored
//      per-user state after `customInit`. Calling `customInit` alone is not
//      sufficient because that consumer later reads `$hasPerMachineInstallation`.
//   4. Wiring: the real build's generated script (`builder-debug.yml`,
//      emitted by electron-builder) must route through the committed
//      include. Skipped with a remedy before any real package exists.
//
// Template copies: `multiUser.nsh`/`UAC.nsh` are copied at runtime from the
// installed builder (script-directory resolution would otherwise fall
// through to NSIS's own `MultiUser.nsh` on this case-insensitive
// filesystem). The StdUtils compile-time plugin comes from the builder's
// `!addplugindir`, exactly like the generated script.

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

const GUARDS = [
  ["INSTALL_MODE_PER_ALL_USERS", "forbids per-machine installs"],
  ["MULTIUSER_INSTALLMODE_ALLOW_ELEVATION", "forbids elevation"],
  ["ONE_CLICK", "requires the assisted installer"],
];

for (const [hostileDefine, messageFragment] of GUARDS) {
  test(
    `a ${hostileDefine} build aborts at compile time`,
    { skip: skipReason },
    (t) => {
      const directory = createCase(t, hostileDefine.toLowerCase());
      fs.writeFileSync(
        path.join(directory, "guard.nsi"),
        [
          "Unicode true",
          'Name "ytvw-guard"',
          'OutFile "guard.exe"',
          "SilentInstall silent",
          "RequestExecutionLevel user",
          '!include "LogicLib.nsh"',
          '!include "FileFunc.nsh"',
          `!define ${hostileDefine}`,
          `!addincludedir "${path.dirname(includePath)}"`,
          '!include "nsis.include"',
          "Section",
          "SectionEnd",
        ].join("\n"),
        "utf8",
      );
      const compiled = compile(directory, "guard.nsi");
      assert.notEqual(
        compiled.status,
        0,
        `${hostileDefine} must abort the build, but it compiled`,
      );
      assert.ok(
        compiled.output.includes(messageFragment),
        `expected the per-user error text, got:\n${compiled.output.slice(-500)}`,
      );
    },
  );
}

test(
  "the install-mode hook forces the per-user flag at runtime",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "flag");
    fs.writeFileSync(
      path.join(directory, "flag.nsi"),
      [
        "Unicode true",
        'Name "ytvw-flag"',
        'OutFile "flag.exe"',
        "SilentInstall silent",
        "RequestExecutionLevel user",
        '!include "LogicLib.nsh"',
        '!include "FileFunc.nsh"',
        '!define APP_EXECUTABLE_FILENAME "app.exe"',
        `!addincludedir "${path.dirname(includePath)}"`,
        '!include "nsis.include"',
        "Var isForceCurrentInstall",
        "Section",
        'StrCpy $isForceCurrentInstall "0"',
        "!insertmacro customInstallMode",
        "!insertmacro customInit",
        "!insertmacro customInstall",
        '${If} $isForceCurrentInstall == "1"',
        `FileOpen $0 "${directory}\\forced.txt" w`,
        'FileWrite $0 "forced"',
        "FileClose $0",
        "${EndIf}",
        "SectionEnd",
      ].join("\n"),
      "utf8",
    );
    const compiled = compile(directory, "flag.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-500));
    assert.equal(await runSilent(path.join(directory, "flag.exe")), 0);
    assert.equal(
      fs.existsSync(path.join(directory, "forced.txt")),
      true,
      "customInstallMode must set the per-user force flag",
    );
  },
);

test(
  "the real silent consumer keeps plain /S installs per-user",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "silent-default");
    // Byte copies of the installed builder templates. The script directory
    // wins NSIS include resolution; without the rename the lookup falls
    // through to NSIS's own MultiUser.nsh on this case-insensitive
    // filesystem.
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
    fs.writeFileSync(
      path.join(directory, "mode.nsi"),
      [
        "Unicode true",
        'Name "ytvw-mode"',
        'OutFile "silent-default.exe"',
        "SilentInstall silent",
        "RequestExecutionLevel user",
        '!include "LogicLib.nsh"',
        '!include "FileFunc.nsh"',
        `!addplugindir /x86-unicode "${pluginsDirectory}"`,
        `!addincludedir "${templateIncludeDirectory}"`,
        '!include "StdUtils.nsh"',
        "!define INSTALL_MODE_PER_ALL_USERS_REQUIRED",
        '!include "ytvw-multiUser.nsh"',
        '!define APP_GUID "00000000-0000-0000-0000-000000000000"',
        '!define UNINSTALL_APP_KEY "ytvw-probe"',
        '!define APP_FILENAME "ytvw-probe"',
        '!define APP_EXECUTABLE_FILENAME "app.exe"',
        `!addincludedir "${path.dirname(includePath)}"`,
        '!include "nsis.include"',
        "Section",
        'StrCpy $hasPerMachineInstallation "0"',
        'StrCpy $hasPerUserInstallation "1"',
        'StrCpy $installMode "CurrentUser"',
        "!insertmacro customInit",
        "!insertmacro customInstall",
        // This is the exact silent consumer from installer.nsi:99-121.
        '${if} $hasPerMachineInstallation == "1"',
        "${andIf} ${Silent}",
        "${ifNot} ${UAC_IsAdmin}",
        "SetErrorLevel 91",
        "Quit",
        "${else}",
        "!insertmacro setInstallModePerAllUsers",
        "${endIf}",
        "${endIf}",
        '${If} $installMode == "CurrentUser"',
        `FileOpen $0 "${directory}\\peruser.txt" w`,
        'FileWrite $0 "peruser"',
        "FileClose $0",
        "${EndIf}",
        `FileOpen $0 "${directory}\\mode-was.txt" w`,
        "FileWrite $0 $installMode",
        "FileClose $0",
        "SectionEnd",
      ].join("\n"),
      "utf8",
    );
    const compiled = compile(directory, "mode.nsi");
    assert.equal(compiled.status, 0, compiled.output.slice(-800));
    assert.equal(
      await runSilent(path.join(directory, "silent-default.exe")),
      0,
    );
    assert.equal(
      fs.existsSync(path.join(directory, "mode-was.txt")),
      true,
      "the harness must record the resulting mode",
    );
    assert.equal(
      fs.readFileSync(path.join(directory, "mode-was.txt"), "utf8"),
      "CurrentUser",
      "the downstream consumer must preserve the default per-user mode",
    );
    assert.equal(
      fs.existsSync(path.join(directory, "peruser.txt")),
      true,
      "the default per-user mode must be observable",
    );
  },
);

test(
  "the real silent /allusers consumer keeps the install per-user",
  { skip: skipReason },
  async (t) => {
    const directory = createCase(t, "silent-allusers");
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
    fs.writeFileSync(
      path.join(directory, "mode.nsi"),
      [
        "Unicode true",
        'Name "ytvw-mode"',
        'OutFile "silent-allusers.exe"',
        "SilentInstall silent",
        "RequestExecutionLevel user",
        '!include "LogicLib.nsh"',
        '!include "FileFunc.nsh"',
        `!addplugindir /x86-unicode "${pluginsDirectory}"`,
        `!addincludedir "${templateIncludeDirectory}"`,
        '!include "StdUtils.nsh"',
        "!define INSTALL_MODE_PER_ALL_USERS_REQUIRED",
        '!include "ytvw-multiUser.nsh"',
        '!define APP_GUID "00000000-0000-0000-0000-000000000000"',
        '!define UNINSTALL_APP_KEY "ytvw-probe"',
        '!define APP_FILENAME "ytvw-probe"',
        '!define APP_EXECUTABLE_FILENAME "app.exe"',
        `!addincludedir "${path.dirname(includePath)}"`,
        '!include "nsis.include"',
        "Section",
        // The exact state initMultiUser leaves behind after parsing /allusers.
        'StrCpy $hasPerMachineInstallation "1"',
        'StrCpy $hasPerUserInstallation "0"',
        'StrCpy $installMode "all"',
        "!insertmacro customInit",
        "!insertmacro customInstall",
        // This is the exact silent consumer from installer.nsi:99-121.
        '${if} $hasPerMachineInstallation == "1"',
        "${andIf} ${Silent}",
        "${ifNot} ${UAC_IsAdmin}",
        "SetErrorLevel 91",
        "Quit",
        "${else}",
        "!insertmacro setInstallModePerAllUsers",
        "${endIf}",
        "${endIf}",
        `FileOpen $0 "${directory}\\mode-was.txt" w`,
        "FileWrite $0 $installMode",
        "FileClose $0",
        "SectionEnd",
      ].join("\n"),
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
      "the real silent consumer must not take its all-users elevation path",
    );
    assert.equal(
      fs.readFileSync(path.join(directory, "mode-was.txt"), "utf8"),
      "CurrentUser",
      "the real silent /allusers consumer must retain CurrentUser",
    );
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
});
