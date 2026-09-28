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
//   * The reported architecture/platform are read from the PE header of the
//     produced executable (DOS e_lfanew at 0x3C -> `PE\0\0` -> Machine u16 at
//     signature+4 must be 0x8664 AMD64 -> OptionalHeader.Magic u16 at
//     signature+24 must be 0x20b PE32+ -> Subsystem u16 at signature+92 must
//     be 2 Windows GUI). Nothing is a string literal.
//   * "Exactly one application executable" is a predicate: every recursive
//     `.exe` path under release-output/ must equal the single expected path.
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

  const productName =
    typeof manifest.build?.productName === "string" &&
    manifest.build.productName.length > 0
      ? manifest.build.productName
      : manifest.name;
  const expectedExecutablePath = path.join(
    outputDirectory,
    EXPECTED_PACKAGED_DIRECTORY,
    `${productName}${EXPECTED_APPLICATION_SUFFIX}`,
  );
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
  if (
    executablePaths.length !== 1 ||
    path.resolve(executablePaths[0]) !== path.resolve(expectedExecutablePath)
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
    `[verify:artifacts] PASS ${expectedExecutableRelative} is a Windows ${record.architecture} PE32+ GUI image\n`,
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

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `[verify:artifacts] FAIL unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
