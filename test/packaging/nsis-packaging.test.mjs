// Task-7 packaging contract suite.
//
// Pins the x64-only full-NSIS configuration in `package.json` and the
// installer/uninstaller halves of `build/nsis.include` through the REAL
// exported predicates in `scripts/verify-artifacts.cjs` — the same
// predicates that gate the build — so a weakened config fails the unit
// chain, not just the release.
//
// Covered:
//   - exactly one `nsis`/`x64` Windows target, machine-wide install with UAC,
//     the Start-menu shortcut, committed include wiring, and the versioned
//     `<product>-<version>-x64.exe` installer convention;
//   - the uninstaller half removes the single ProgramData machine tree named
//     by `src/main/profile-path.ts`, keeps it on the `/KEEP_APP_DATA`
//     upgrade path, and fails bilingually (never silently) on a lock;
//   - the installer half keeps the per-user enforcement hooks and contains
//     none of the retired update-handoff protocol.

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const manifest = require(path.join(repositoryRoot, "package.json"));
const {
  checkManifestContract,
  expectedInstallerName,
  renderArtifactName,
} = require(path.join(repositoryRoot, "scripts", "verify-artifacts.cjs"));
const { PROFILE_DIRECTORY_NAME } =
  await import("../../src/main/profile-path.ts");

const includePath = path.join(repositoryRoot, "build", "nsis.include");

function mutated(mutator) {
  const clone = JSON.parse(JSON.stringify(manifest));
  mutator(clone);
  return clone;
}

function assertRejected(candidate, pattern) {
  const failures = checkManifestContract(candidate);
  assert.ok(
    failures.length > 0,
    `expected the mutated manifest to fail the contract, got no failures: ${JSON.stringify(candidate.build)}`,
  );
  assert.match(
    failures.join("\n"),
    pattern,
    `expected a failure matching ${pattern}, got:\n${failures.join("\n")}`,
  );
}

test("the manifest produces exactly one unsigned x64 per-machine NSIS installer", () => {
  assert.deepEqual(checkManifestContract(manifest), []);
});

test("the installer asset follows the versioned x64 convention", () => {
  const expected = `${manifest.build.productName}-${manifest.version}-x64.exe`;
  assert.equal(expectedInstallerName(manifest), expected);
  assert.equal(
    renderArtifactName(manifest.build.nsis.artifactName, manifest),
    expected,
  );
});

test("an unrenderable artifact template fails closed", () => {
  assert.equal(
    renderArtifactName("${productName}-${unknownMacro}.exe", manifest),
    undefined,
  );
  assertRejected(
    mutated((draft) => {
      draft.build.nsis.artifactName = "${productName}-${unknownMacro}.exe";
    }),
    /renderable/,
  );
});

test("a non-NSIS or non-x64 target is rejected", () => {
  assertRejected(
    mutated((draft) => {
      draft.build.win.target = [{ target: "dir", arch: ["x64"] }];
    }),
    /build\.win\.target must be exactly/,
  );
  assertRejected(
    mutated((draft) => {
      draft.build.win.target = [{ target: "nsis", arch: ["ia32"] }];
    }),
    /build\.win\.target must be exactly/,
  );
  assertRejected(
    mutated((draft) => {
      draft.build.win.target = [
        { target: "nsis", arch: ["x64"] },
        { target: "nsis", arch: ["arm64"] },
      ];
    }),
    /build\.win\.target must be exactly/,
  );
});

test("per-machine and shortcut options cannot be weakened", () => {
  assertRejected(
    mutated((draft) => {
      draft.build.win.requestedExecutionLevel = "highestAvailable";
    }),
    /asInvoker/,
  );
  for (const [option, wanted] of [
    ["oneClick", true],
    ["perMachine", false],
    ["allowElevation", false],
    ["packElevateHelper", false],
    ["deleteAppDataOnUninstall", true],
    ["createStartMenuShortcut", false],
    // The desktop shortcut is the one flag that is legitimately false: the
    // installer asks the user for it, so flipping it back to true (making the
    // template create one unasked) is the regression to reject here.
    ["createDesktopShortcut", true],
    ["runAfterFinish", false],
    ["warningsAsErrors", false],
  ]) {
    assertRejected(
      mutated((draft) => {
        draft.build.nsis[option] = wanted;
      }),
      new RegExp(`build\\.nsis\\.${option} must be`),
    );
  }
  assertRejected(
    mutated((draft) => {
      delete draft.build.nsis.allowElevation;
    }),
    /build\.nsis\.allowElevation must be/,
  );
  assertRejected(
    mutated((draft) => {
      draft.build.nsis.include = "other.nsh";
    }),
    /nsis\.include/,
  );
});

test("the package script emits the installer and nothing else", () => {
  assertRejected(
    mutated((draft) => {
      draft.scripts.package = `${draft.scripts.package} --dir`;
    }),
    /"--dir"/,
  );
  assertRejected(
    mutated((draft) => {
      draft.scripts.package = draft.scripts.package.replace("--x64", "--arm64");
    }),
    /"--x64"/,
  );
  assertRejected(
    mutated((draft) => {
      draft.scripts.package = `${draft.scripts.package} --ia32`;
    }),
    /"--ia32"/,
  );
  assertRejected(
    mutated((draft) => {
      draft.scripts.package = `${draft.scripts.package} portable`;
    }),
    /"portable"/,
  );
});

test("the uninstaller half removes exactly the ProgramData machine tree", () => {
  const source = fs.readFileSync(includePath, "utf8");
  assert.match(source, /!macro customUnInstall/);
  assert.match(source, /!macro YTVW_REMOVE_DATA_DIRECTORY/);
  assert.match(source, /\/KEEP_APP_DATA/);
  assert.ok(
    source.includes(PROFILE_DIRECTORY_NAME),
    `the include must name the machine directory "${PROFILE_DIRECTORY_NAME}" from profile-path.ts`,
  );
  const uninstallStart = source.search(/^!ifdef BUILD_UNINSTALLER\s*$/m);
  assert.ok(uninstallStart >= 0, "the real uninstaller build guard must exist");
  const uninstallHalf = source.slice(uninstallStart);
  const uninstallCode = uninstallHalf.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    uninstallCode,
    /^[\t ]*RMDir[\t ]+[^;\r\n]*\/r(?:[\t ;]|$)/im,
    "data removal must not execute RMDir /r, which follows directory junctions",
  );
  assert.match(
    uninstallCode,
    /^[\t ]*!include[\t ]+"[^"\r\n]*\bnsis-safe-delete\.nsh"/m,
    "the uninstaller must include build/nsis-safe-delete.nsh",
  );
  const removeMacro = uninstallCode.match(
    /^[\t ]*!macro YTVW_REMOVE_DATA_DIRECTORY[\t ]*\r?\n([\s\S]*?)^[\t ]*!macroend\b/m,
  );
  assert.ok(
    removeMacro,
    "the data-removal macro must exist in the uninstaller",
  );
  assert.match(
    removeMacro[1],
    /^[\t ]*Call[\t ]+un\.YTVWRemoveDataTree(?:[\t ;]|$)/m,
    "data removal must call the public safe-delete wrapper un.YTVWRemoveDataTree",
  );
  assert.match(
    uninstallHalf,
    /ReadEnvStr.*ProgramData/,
    "the uninstaller half must resolve its base from the ProgramData environment",
  );
  assert.match(
    uninstallHalf,
    /YTVW_MACHINE_DIR_NAME/,
    "the uninstaller half must remove the single machine directory name",
  );
  for (const retired of [
    "YTVW_DATA_ROOT",
    "YTVW_DATA_DIR_NAME",
    "YTVW_ROAMING_DATA_ROOT",
    "YTVW_ROAMING_DATA_DIR_NAME",
    "$LOCALAPPDATA",
    "$APPDATA",
  ]) {
    assert.ok(
      !uninstallHalf.includes(retired),
      `the per-user root "${retired}" must not survive in the uninstaller half`,
    );
  }
});

test("a locked profile fails bilingually instead of silently", () => {
  const source = fs.readFileSync(includePath, "utf8");
  assert.ok(
    source.includes("無法移除設定檔與應用程式資料"),
    "the lock failure must carry the Traditional Chinese message",
  );
  assert.ok(
    source.includes("could not be removed"),
    "the lock failure must carry the English message",
  );
  assert.match(source, /\/SD IDOK/);
  const uninstallStart = source.search(/^!ifdef BUILD_UNINSTALLER\s*$/m);
  assert.ok(uninstallStart >= 0, "the real uninstaller build guard must exist");
  const uninstallHalf = source.slice(uninstallStart);
  assert.match(uninstallHalf, /Abort/);
});

test("the retired update-handoff protocol is absent and both halves survive", () => {
  const source = fs.readFileSync(includePath, "utf8");
  for (const retired of [
    "YTVW_VALIDATE_NONCE",
    "YTVW_PARSE_HANDOFF",
    "YTVW_WAIT_FOR_PARENT",
    "YTVW_WRITE_SUCCESS_MARKER",
    "YTVW_RELAUNCH_APP",
    "YTVW_STATUS_DIR",
    "--update-parent-pid",
    "--update-nonce",
    "success-",
    "ytvwHandoffMode",
  ]) {
    assert.ok(
      !source.includes(retired),
      `the retired handoff symbol "${retired}" must not survive in nsis.include`,
    );
  }
  assert.match(source, /!macro customInit/);
  assert.match(source, /!macro customUnInstall/);
  assert.match(source, /YTVW_REMOVE_DATA_DIRECTORY/);
  assert.match(source, /!ifndef BUILD_UNINSTALLER/);
  assert.match(source, /!ifdef BUILD_UNINSTALLER/);
});

test("the include is UTF-8 with BOM so makensis reads the Chinese text", () => {
  const bytes = fs.readFileSync(includePath).subarray(0, 3);
  assert.deepEqual(
    [...bytes],
    [0xef, 0xbb, 0xbf],
    "without a BOM makensis reads the script as ACP and aborts with Bad text encoding",
  );
});
