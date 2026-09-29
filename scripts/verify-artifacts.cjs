"use strict";

// Hardened release-artifact verifier.
//
// Everything here is fail-closed and derived from observable artifacts:
//   * Top-level directory set of `release-output/` must equal exactly
//     {win-unpacked}. electron-builder's real sibling names for the other
//     architectures are win-ia32-unpacked / win-arm64-unpacked / linux-*
//     / mac*, so a denylist of guessed names is a silent no-op; an exact-set
//     assertion is the only shape that cannot be fooled by a name never seen
//     before.
//   * Exactly one top-level installer `.exe` must exist and its name must
//     equal the versioned convention
//     `<productName>-<version>-x64.exe`, which is also what the configured
//     `build.nsis.artifactName` template must render to. The only other
//     permitted top-level files are electron-builder's own pinned
//     byproducts (`<installer>.exe.blockmap`, `latest.yml`,
//     `builder-debug.yml`, `builder-effective-config.yaml`); anything else
//     fails closed by name.
//   * The application executable is `win-unpacked/<productName>.exe`; every
//     recursive `.exe` under `release-output/` must be either that file or
//     the top-level installer (an `elevate.exe` helper or any stray binary
//     fails). The reported architecture/platform are read from the PE header
//     of the produced application executable (DOS e_lfanew at 0x3C ->
//     `PE\0\0` -> Machine u16 at signature+4 must be 0x8664 AMD64 ->
//     OptionalHeader.Magic u16 at signature+24 must be 0x20b PE32+ ->
//     Subsystem u16 at signature+92 must be 2 Windows GUI). Nothing is a
//     string literal. The installer stub itself is name/count-checked only:
//     NSIS installer stubs are not x64 images, so a PE arch assertion on
//     them would false-fail.
//   * The manifest packaging contract (`build.win` / `build.nsis` / the
//     `package` script) is asserted by `checkManifestContract` and exported
//     for the unit suite, so the same predicate gates the build and the
//     tests with no duplicated logic.
//   * WebView2 detection walks every path SEGMENT (files and directories)
//     relative to release-output/, so a runtime laid down as a directory with
//     innocuous filenames is caught, while a checkout path that merely
//     contains "webview2" is not.
//   * Signing material is caught by extension (.pfx .p12 .pvk .cer .spc) and
//     forbidden archive/installer formats by extension.

const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "package.json");

const EXPECTED_PACKAGED_DIRECTORY = "win-unpacked";
const EXPECTED_APPLICATION_SUFFIX = ".exe";
const EXPECTED_INSTALLER_ARCH_LABEL = "x64";

const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const PE_MACHINE_AMD64 = 0x8664;
const PE_MACHINE_IA32 = 0x14c;
const PE_MACHINE_ARM64 = 0xaa64;
const PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b;
const PE_OPTIONAL_HEADER_MAGIC_PE32 = 0x10b;
const PE_SUBSYSTEM_WINDOWS_GUI = 2;
const PE_SUBSYSTEM_WINDOWS_CONSOLE = 3;

const ARCHITECTURE_BY_MACHINE = new Map([
  [PE_MACHINE_AMD64, "x64"],
  [PE_MACHINE_IA32, "ia32"],
  [PE_MACHINE_ARM64, "arm64"],
]);

// Top-level files electron-builder unconditionally emits beside the
// installer for an NSIS target, even with `--publish never`:
//   - `<installer>.exe.blockmap` and `latest.yml` (differential-update and
//     electron-updater metadata). This application has no update subsystem
//     and electron-updater is not a dependency, so nothing consumes them;
//     they are kept in the allowlist only because electron-builder emits
//     them beside the installer.
//   - `builder-debug.yml` / `builder-effective-config.yaml` (build records).
// The allowlist is EXACT: any other top-level file fails closed by name, so
// a ZIP, portable, second-architecture, or signed artifact can never slip
// through, and the release workflow uploads only the explicitly named
// installer.
function allowedTopLevelFile(fileName, expectedInstaller) {
  return (
    fileName === expectedInstaller ||
    fileName === `${expectedInstaller}.blockmap` ||
    fileName === "latest.yml" ||
    fileName === "builder-debug.yml" ||
    fileName === "builder-effective-config.yaml"
  );
}

const FORBIDDEN_SIGNING_MATERIAL_EXTENSIONS = new Set([
  ".pfx",
  ".p12",
  ".pvk",
  ".cer",
  ".spc",
]);
const FORBIDDEN_ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".7z",
  ".msi",
  ".msix",
  ".msixbundle",
  ".appx",
  ".appxbundle",
]);
const WEBVIEW2_FRAGMENTS = ["webview2", "edgewebview"];

function hex(value) {
  return `0x${value.toString(16)}`;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

function productNameOf(manifest) {
  return typeof manifest.build?.productName === "string" &&
    manifest.build.productName.length > 0
    ? manifest.build.productName
    : manifest.name;
}

// The single versioned installer asset convention, owed to the release
// workflow: `<productName>-<version>-x64.exe`.
function expectedInstallerName(manifest) {
  return `${productNameOf(manifest)}-${manifest.version}-${EXPECTED_INSTALLER_ARCH_LABEL}.exe`;
}

// Renders the configured `build.nsis.artifactName` template against the
// manifest. Returns undefined when the template carries a macro this
// verifier does not bind (fail closed: an unrenderable name can never be
// proven to match the convention).
function renderArtifactName(template, manifest) {
  if (typeof template !== "string" || template.length === 0) {
    return undefined;
  }
  // The `${...}` macro spellings are assembled, never written as string
  // literals: the Biome language server flags a literal "${" inside a plain
  // string as a probable template mistake.
  const open = "$" + "{";
  const rendered = template
    .split(`${open}productName}`)
    .join(productNameOf(manifest))
    .split(`${open}version}`)
    .join(String(manifest.version))
    .split(`${open}arch}`)
    .join(EXPECTED_INSTALLER_ARCH_LABEL)
    .split(`${open}ext}`)
    .join("exe");
  if (/\$\{[^}]+\}/.test(rendered)) {
    return undefined;
  }
  return rendered;
}

// Asserts the packaging configuration that produces exactly one unsigned
// x64 per-user NSIS installer. Returns a list of failure strings (empty
// when the contract holds). This is the same predicate the unit suite
// exercises against mutated manifests, so a weakened config fails both.
function checkManifestContract(manifest) {
  const failures = [];
  if (manifest === undefined || manifest === null) {
    return ["cannot read package.json"];
  }
  if (manifest.build === undefined || manifest.build === null) {
    return ["package.json is missing build configuration"];
  }

  const targets = manifest.build.win?.target ?? [];
  if (
    targets.length !== 1 ||
    targets[0]?.target !== "nsis" ||
    targets[0]?.arch === undefined ||
    targets[0].arch.length !== 1 ||
    targets[0].arch[0] !== "x64"
  ) {
    failures.push(
      `build.win.target must be exactly [{target:"nsis",arch:["x64"]}]; found ${JSON.stringify(targets)}`,
    );
  }
  if (manifest.build.win?.requestedExecutionLevel !== "asInvoker") {
    failures.push(
      "build.win.requestedExecutionLevel must be asInvoker (a standard per-user install needs no UAC)",
    );
  }

  const nsis = manifest.build.nsis;
  if (nsis === undefined || nsis === null) {
    failures.push("package.json is missing build.nsis configuration");
  } else {
    const expected = expectedInstallerName(manifest);
    const rendered = renderArtifactName(nsis.artifactName, manifest);
    if (rendered === undefined) {
      failures.push(
        `build.nsis.artifactName must be a renderable template; found ${JSON.stringify(nsis.artifactName)}`,
      );
    } else if (rendered !== expected) {
      failures.push(
        `build.nsis.artifactName must render to the versioned convention "${expected}"; renders to "${rendered}"`,
      );
    }
    for (const [option, wanted] of [
      ["oneClick", false],
      ["perMachine", false],
      ["allowElevation", false],
      ["packElevateHelper", false],
      ["createDesktopShortcut", true],
      ["createStartMenuShortcut", true],
      ["deleteAppDataOnUninstall", false],
      ["warningsAsErrors", true],
    ]) {
      if (nsis[option] !== wanted) {
        failures.push(
          `build.nsis.${option} must be ${JSON.stringify(wanted)}; found ${JSON.stringify(nsis[option])}`,
        );
      }
    }
    // `runAfterFinish` is kept true as a plain post-install UX choice, not an
    // update-contract requirement: in the assisted installer it keeps the
    // finish page's "run the app" affordance, and electron-builder launches
    // the app as the invoking (non-elevated) user. The retired in-app update
    // path relaunched the app itself, so no update behaviour depends on this
    // option. The assertion stays so a config change cannot silently drop the
    // launch-after-install affordance.
    if (nsis.runAfterFinish !== true) {
      failures.push(
        `build.nsis.runAfterFinish must be true (post-install launch UX); found ${JSON.stringify(nsis.runAfterFinish)}`,
      );
    }
    const includeName =
      typeof nsis.include === "string"
        ? nsis.include.split("/").pop()?.split("\\").pop()
        : undefined;
    if (includeName !== "nsis.include") {
      failures.push(
        `build.nsis.include must resolve to the committed nsis.include installer/uninstaller script; found ${JSON.stringify(nsis.include)}`,
      );
    }
  }

  const packageScript = manifest.scripts?.package;
  if (typeof packageScript !== "string") {
    failures.push("package.json is missing the package script");
  } else {
    for (const required of ["electron-builder", "--win", "--x64"]) {
      if (!packageScript.includes(required)) {
        failures.push(`the package script must contain "${required}"`);
      }
    }
    // --dir would emit only the unpacked directory and skip the installer;
    // every other token would emit a forbidden artifact or architecture.
    const forbidden =
      /--dir|--ia32|--arm64|portable|\bzip\b|\bmsi\b|\bmsix\b|\bappx\b/i;
    const hit = forbidden.exec(packageScript);
    if (hit !== null) {
      failures.push(
        `the package script must not contain "${hit[0]}" (exactly one unsigned x64 NSIS installer is emitted)`,
      );
    }
  }
  return failures;
}

function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(handle, buffer, 0, length, position);
  if (bytesRead < length) {
    return undefined;
  }
  return buffer;
}

function readPeIdentity(executablePath) {
  const handle = fs.openSync(executablePath, "r");
  try {
    const dosHeader = readAt(handle, 0, 64);
    if (dosHeader === undefined) {
      return undefined;
    }
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = readAt(handle, peOffset, 96);
    if (peHeader === undefined) {
      return undefined;
    }
    return {
      eLfanew: peOffset,
      signature: peHeader.readUInt32LE(0),
      machine: peHeader.readUInt16LE(4),
      optionalHeaderMagic: peHeader.readUInt16LE(24),
      subsystem: peHeader.readUInt16LE(24 + 68),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function collectEntries(rootDirectory) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      entries.push({ fullPath, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  walk(rootDirectory);
  return entries;
}

function relativeToOutput(outputDirectory, targetPath) {
  return path.relative(outputDirectory, targetPath).split(path.sep).join("/");
}

function main() {
  const failures = [];
  const manifest = readManifest();
  if (manifest === undefined) {
    failures.push(`cannot read ${MANIFEST_PATH}`);
    return report(failures);
  }
  for (const failure of checkManifestContract(manifest)) {
    failures.push(failure);
  }
  const outputName = manifest.build?.directories?.output;
  if (typeof outputName !== "string" || outputName.length === 0) {
    failures.push("package.json is missing build.directories.output");
    return report(failures);
  }
  const outputDirectory = path.resolve(REPOSITORY_ROOT, outputName);
  const relativeOutput = path
    .relative(REPOSITORY_ROOT, outputDirectory)
    .split(path.sep)
    .join("/");
  if (
    !fs.existsSync(outputDirectory) ||
    !fs.statSync(outputDirectory).isDirectory()
  ) {
    failures.push(`missing release output directory ${relativeOutput}/`);
    return report(failures);
  }

  const topLevelEntries = fs.readdirSync(outputDirectory, {
    withFileTypes: true,
  });
  const topLevelDirectories = topLevelEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const directoryName of topLevelDirectories) {
    if (directoryName !== EXPECTED_PACKAGED_DIRECTORY) {
      failures.push(
        `${relativeOutput}/ contains the unsupported release directory "${directoryName}"; ` +
          `only "${EXPECTED_PACKAGED_DIRECTORY}" (Windows x64) may be produced`,
      );
    }
  }
  if (!topLevelDirectories.includes(EXPECTED_PACKAGED_DIRECTORY)) {
    failures.push(
      `${relativeOutput}/ is missing the "${EXPECTED_PACKAGED_DIRECTORY}" directory`,
    );
    return report(failures);
  }

  const entries = collectEntries(outputDirectory);
  const fileEntries = entries.filter((entry) => !entry.isDirectory);

  const productName = productNameOf(manifest);
  const expectedExecutablePath = path.join(
    outputDirectory,
    EXPECTED_PACKAGED_DIRECTORY,
    `${productName}${EXPECTED_APPLICATION_SUFFIX}`,
  );
  const expectedInstallerNameValue = expectedInstallerName(manifest);
  const expectedInstallerPath = path.join(
    outputDirectory,
    expectedInstallerNameValue,
  );

  const topLevelFiles = topLevelEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const fileName of topLevelFiles) {
    if (!allowedTopLevelFile(fileName, expectedInstallerNameValue)) {
      failures.push(
        `${relativeOutput}/${fileName} is not the expected versioned installer "${expectedInstallerNameValue}" or a pinned builder byproduct`,
      );
    }
  }
  if (!topLevelFiles.includes(expectedInstallerNameValue)) {
    failures.push(
      `${relativeOutput}/ is missing the versioned installer "${expectedInstallerNameValue}"`,
    );
    return report(failures);
  }

  const executablePaths = fileEntries
    .map((entry) => entry.fullPath)
    .filter(
      (filePath) =>
        path.extname(filePath).toLowerCase() === EXPECTED_APPLICATION_SUFFIX,
    );
  const expectedExecutableRelative = relativeToOutput(
    outputDirectory,
    expectedExecutablePath,
  );
  const expectedInstallerRelative = relativeToOutput(
    outputDirectory,
    expectedInstallerPath,
  );
  const allowedExecutables = new Set([
    path.resolve(expectedExecutablePath),
    path.resolve(expectedInstallerPath),
  ]);
  const unexpectedExecutables = executablePaths.filter(
    (filePath) => !allowedExecutables.has(path.resolve(filePath)),
  );
  if (unexpectedExecutables.length > 0) {
    failures.push(
      `unexpected executable(s) under ${relativeOutput}/: ` +
        unexpectedExecutables
          .map((filePath) => relativeToOutput(outputDirectory, filePath))
          .join(", "),
    );
  }
  const resolvedExecutables = new Set(
    executablePaths.map((filePath) => path.resolve(filePath)),
  );
  if (
    !resolvedExecutables.has(path.resolve(expectedExecutablePath)) ||
    resolvedExecutables.size !== 2
  ) {
    const found = executablePaths.map((filePath) =>
      relativeToOutput(outputDirectory, filePath),
    );
    failures.push(
      `expected exactly one application executable at ${expectedExecutableRelative}; found ` +
        `${executablePaths.length}: ${found.length > 0 ? found.join(", ") : "(none)"}`,
    );
    return report(failures);
  }

  const identity = readPeIdentity(expectedExecutablePath);
  if (identity === undefined) {
    failures.push(
      `${expectedExecutableRelative} is too short to contain a PE header`,
    );
    return report(failures);
  }
  if (identity.signature !== PE_SIGNATURE) {
    failures.push(
      `${expectedExecutableRelative} has no PE signature at e_lfanew ${hex(identity.eLfanew)} ` +
        `(found ${hex(identity.signature)}, expected ${hex(PE_SIGNATURE)})`,
    );
  }
  const architecture = ARCHITECTURE_BY_MACHINE.get(identity.machine);
  if (identity.machine !== PE_MACHINE_AMD64) {
    failures.push(
      `${expectedExecutableRelative} Machine must be ${hex(PE_MACHINE_AMD64)} (AMD64), ` +
        `found ${hex(identity.machine)}${architecture === undefined ? "" : ` (${architecture})`}`,
    );
  }
  if (identity.optionalHeaderMagic !== PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS) {
    failures.push(
      `${expectedExecutableRelative} OptionalHeader.Magic must be ` +
        `${hex(PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS)} (PE32+), found ${hex(identity.optionalHeaderMagic)}` +
        `${identity.optionalHeaderMagic === PE_OPTIONAL_HEADER_MAGIC_PE32 ? " (PE32)" : ""}`,
    );
  }
  if (
    identity.subsystem !== PE_SUBSYSTEM_WINDOWS_GUI &&
    identity.subsystem !== PE_SUBSYSTEM_WINDOWS_CONSOLE
  ) {
    failures.push(
      `${expectedExecutableRelative} Subsystem must be ${PE_SUBSYSTEM_WINDOWS_GUI} (Windows GUI), ` +
        `found ${identity.subsystem}`,
    );
  }
  const platform =
    identity.subsystem === PE_SUBSYSTEM_WINDOWS_GUI ||
    identity.subsystem === PE_SUBSYSTEM_WINDOWS_CONSOLE
      ? "win32"
      : "unknown";

  for (const entry of entries) {
    const segments = relativeToOutput(outputDirectory, entry.fullPath)
      .toLowerCase()
      .split("/");
    for (const fragment of WEBVIEW2_FRAGMENTS) {
      if (segments.some((segment) => segment.includes(fragment))) {
        failures.push(
          `${relativeToOutput(outputDirectory, entry.fullPath)} matched the forbidden ` +
            `WebView2 fragment "${fragment}" (bundled Chromium only)`,
        );
        break;
      }
    }
  }

  for (const filePath of fileEntries.map((entry) => entry.fullPath)) {
    const relativePath = relativeToOutput(outputDirectory, filePath);
    const extension = path.extname(filePath).toLowerCase();
    if (FORBIDDEN_SIGNING_MATERIAL_EXTENSIONS.has(extension)) {
      failures.push(`${relativePath} (forbidden signing material)`);
    }
    if (FORBIDDEN_ARCHIVE_EXTENSIONS.has(extension)) {
      failures.push(`${relativePath} (forbidden archive or installer format)`);
    }
  }

  if (failures.length > 0) {
    return report(failures);
  }

  const record = {
    status: "pass",
    generator: "scripts/verify-artifacts.cjs",
    outputDirectory: relativeOutput,
    packagedDirectory: `${relativeOutput}/${EXPECTED_PACKAGED_DIRECTORY}`,
    applicationExecutable: expectedExecutableRelative,
    installer: expectedInstallerRelative,
    architecture: architecture ?? "unknown",
    platform,
    pe: {
      eLfanew: hex(identity.eLfanew),
      signature: hex(identity.signature),
      machine: hex(identity.machine),
      optionalHeaderMagic: hex(identity.optionalHeaderMagic),
      subsystem: identity.subsystem,
    },
    filesInspected: fileEntries.length,
    executablesInspected: executablePaths.length,
    webview2Fragments: [],
    forbiddenSigningMaterial: [],
    forbiddenArchiveFormats: [],
  };
  process.stdout.write(
    `[verify:artifacts] PASS ${expectedExecutableRelative} is a Windows ${record.architecture} PE32+ GUI image, installer ${expectedInstallerRelative}\n`,
  );
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

function report(failures) {
  for (const failure of failures) {
    process.stderr.write(`[verify:artifacts] FAIL ${failure}\n`);
  }
  process.exitCode = 1;
  return 1;
}

module.exports = {
  expectedInstallerName,
  renderArtifactName,
  checkManifestContract,
  productNameOf,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `[verify:artifacts] FAIL unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
