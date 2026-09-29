"use strict";

// Fail-closed delivery-matrix verifier for the clean Windows environments.
//
// The delivery claim this verifier gates is expensive and partly manual: it is
// the claim that the pinned x64 NSIS candidate installs, launches, updates and
// uninstalls on a clean Windows 10 1809 x64 machine and on a current Windows 11
// x64 machine as a STANDARD user. Only a human on a real machine can produce
// that evidence, so the verifier's job is to make a green verdict impossible
// without it. Everything here fails closed:
//
//   * The matrix is exact: REQUIRED_ENVIRONMENTS x REQUIRED_COMMANDS rows, and
//     every one of them must be present, uniquely identified, and bound to the
//     candidate version passed on the command line. A row copied from a previous
//     candidate is stale evidence and is rejected by name.
//   * A row is evidence only when it carries a concrete, non-placeholder
//     `artifactPath` that resolves INSIDE `artifactRoot` and is a regular
//     non-empty file on disk. A green command with a placeholder path, a
//     directory, an empty file, or an absolute/traversing path is not evidence:
//     it is a claim. `resolveArtifact` refuses absolute paths and any path that
//     escapes `artifactRoot`, so an index cannot cite the machine it runs on.
//   * The OS fixture is pinned, not free text: a row may only claim the
//     environment it belongs to. windows-10-1809-x64 must be a Windows 10 x64
//     build in [17763, 19045], and windows-11-current-x64 must be a Windows 11
//     x64 build >= 22000. A row that claims a different release, family,
//     architecture, or build range is an unsupported OS fixture and fails
//     naming the row. (17763 is the plan's own Windows 10 1809 floor, which is
//     inside Electron's declared "Windows 10 and up" platform support; see
//     `release-evidence-schema/delivery-matrix-evidence.schema.json`.)
//   * Row-level result binding is exact: `execution` must be "executed",
//     `observedResult` must be "pass", and `exitCode` must be 0. An
//     "unexecuted"/"not-run"/nonzero row fails naming the row, so the report
//     for a matrix that no VM has ever executed cannot read as a pass.
//   * `synthetic` must be a present JSON boolean. It exists to keep the test
//     positive control from being mistaken for machine evidence; an index that
//     simply omits it would otherwise produce a pass record whose
//     `synthetic: false` is a claim of real evidence that nobody made. The PASS
//     record echoes it and the PASS line says so out loud.
//   * The clean-environment rows assert their own observable proof, not a
//     checkbox: the shortcut row must name a shortcut file that exists, the
//     uninstaller row must name the exact profile path that is ABSENT after
//     uninstall, and the artifact-completeness row must name an installer and
//     an application executable that both exist and whose PE header is read
//     (DOS e_lfanew at 0x3C -> `PE\0\0` -> Machine u16 at signature+4 must be
//     0x8664 AMD64 -> OptionalHeader.Magic u16 at signature+24 must be 0x20b
//     PE32+), reusing the `scripts/verify-artifacts.cjs` approach rather than
//     trusting a file name.
//   * Diagnostics always name the failing row id; there is no generic error
//     path once an index has been parsed.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = "delivery-matrix-evidence/v1";
const CANDIDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const REQUIRED_ENVIRONMENTS = [
  {
    id: "windows-10-1809-x64",
    release: "10",
    minimumBuild: 17763,
    maximumBuild: 19045,
  },
  { id: "windows-11-current-x64", release: "11", minimumBuild: 22000 },
];
const REQUIRED_COMMANDS = [
  "npm run preflight",
  "npm run lint",
  "npm run format:check",
  "npm run typecheck",
  "npm run test:unit",
  "npm run test:electron",
  "npm run package",
  "npm run verify:artifacts",
  "npm run verify:static",
  "npm run verify:windows",
  "standard-user install no-admin-elevation",
  "start-menu shortcut launch",
  "update-failure fallback",
  "uninstaller profile deletion",
  "artifact completeness",
];

const COMMAND_WITH_INSTALLER = "artifact completeness";
const COMMAND_WITH_SHORTCUT = "start-menu shortcut launch";
const COMMAND_WITH_PROFILE = "uninstaller profile deletion";
const COMMAND_WITH_NO_ELEVATION = "standard-user install no-admin-elevation";
const COMMAND_WITH_UPDATE_FALLBACK = "update-failure fallback";

// Every one of these is rejected as "not filled in". The empty alternative is
// deliberate: an absent or zero-length value is a placeholder too.
const PLACEHOLDER = /^(?:|tbd|todo|n\/a|none|unknown|unexecuted|<[^>]+>)$/i;

const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const PE_MACHINE_AMD64 = 0x8664;
const PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS = 0x20b;
const PE_MACHINE_BY_VALUE = new Map([
  [PE_MACHINE_AMD64, "AMD64"],
  [0x14c, "i386"],
  [0xaa64, "ARM64"],
]);

function rowId(environmentId, command) {
  return `${environmentId}:${command}`;
}

function isPlaceholder(value) {
  return typeof value !== "string" || PLACEHOLDER.test(value.trim());
}

function report(failures) {
  for (const failure of failures) {
    process.stderr.write(`[verify:delivery-matrix] FAIL ${failure}\n`);
  }
  process.exitCode = 1;
  return 1;
}

// Resolves a row-relative artifact path against the index's artifactRoot.
// Returns undefined for placeholders, absolute paths, and any path that
// escapes the root, so a row can never cite a file outside the evidence tree.
function resolveArtifact(root, artifactPath) {
  if (isPlaceholder(artifactPath) || path.isAbsolute(artifactPath)) {
    return undefined;
  }
  const resolved = path.resolve(root, artifactPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

// A row's artifact is evidence only if it is a regular, non-empty file. A
// directory, an empty file, or a missing path all fail naming the row.
function checkArtifact(root, artifactPath, row, label, failures) {
  const resolved = resolveArtifact(root, artifactPath);
  if (resolved === undefined) {
    failures.push(
      `row "${row.rowId}" has an invalid ${label} path "${artifactPath}" (must be relative to artifactRoot)`,
    );
    return undefined;
  }
  if (!fs.existsSync(resolved)) {
    failures.push(
      `row "${row.rowId}" ${label} does not exist: "${artifactPath}"`,
    );
    return undefined;
  }
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) {
    failures.push(
      `row "${row.rowId}" ${label} is not a regular file: "${artifactPath}"`,
    );
    return undefined;
  }
  if (stats.size === 0) {
    failures.push(
      `row "${row.rowId}" ${label} is empty: "${artifactPath}" (an empty artifact is not evidence)`,
    );
    return undefined;
  }
  return resolved;
}

function readPeMachine(executablePath) {
  const handle = fs.openSync(executablePath, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const dos = Buffer.alloc(64);
    if (fs.readSync(handle, dos, 0, dos.length, 0) !== dos.length) {
      return undefined;
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 26 > size) {
      return undefined;
    }
    const header = Buffer.alloc(26);
    if (
      fs.readSync(handle, header, 0, header.length, peOffset) !== header.length
    ) {
      return undefined;
    }
    return {
      eLfanew: peOffset,
      signature: header.readUInt32LE(0),
      machine: header.readUInt16LE(4),
      optionalHeaderMagic: header.readUInt16LE(24),
    };
  } finally {
    fs.closeSync(handle);
  }
}

function checkArtifactCompleteness(row, artifactRoot, failures) {
  checkArtifact(artifactRoot, row.installerPath, row, "installer", failures);
  const application = checkArtifact(
    artifactRoot,
    row.applicationExecutablePath,
    row,
    "application executable",
    failures,
  );
  if (application === undefined) {
    return;
  }
  const identity = readPeMachine(application);
  if (identity === undefined) {
    failures.push(
      `row "${row.rowId}" application executable "${row.applicationExecutablePath}" is too short to contain a PE header`,
    );
    return;
  }
  const machineName = PE_MACHINE_BY_VALUE.get(identity.machine) ?? "unknown";
  if (
    identity.signature !== PE_SIGNATURE ||
    identity.machine !== PE_MACHINE_AMD64 ||
    identity.optionalHeaderMagic !== PE_OPTIONAL_HEADER_MAGIC_PE32_PLUS
  ) {
    failures.push(
      `row "${row.rowId}" has wrong-architecture artifact "${row.applicationExecutablePath}" ` +
        `(Machine 0x${identity.machine.toString(16)} ${machineName}, ` +
        `OptionalHeader.Magic 0x${identity.optionalHeaderMagic.toString(16)}; expected AMD64 PE32+)`,
    );
  }
}

// The clean-environment rows each assert an observable end state. The profile
// row is the one that can be satisfied by a bare boolean, so it insists on a
// concrete path that is provably absent: "profileAbsentAfterUninstall: true"
// with no path would be a checkbox, not evidence.
function checkInteraction(row, artifactRoot, failures) {
  if (row.command === COMMAND_WITH_SHORTCUT) {
    checkArtifact(artifactRoot, row.shortcutPath, row, "shortcut", failures);
  }
  if (row.command === COMMAND_WITH_PROFILE) {
    const profile = resolveArtifact(artifactRoot, row.profilePath);
    if (profile === undefined) {
      failures.push(
        `row "${row.rowId}" has no usable profilePath "${row.profilePath}" (it must be a concrete path relative to artifactRoot)`,
      );
    } else if (fs.existsSync(profile)) {
      failures.push(
        `row "${row.rowId}" has stale profile "${row.profilePath}" (the profile must be gone after uninstall)`,
      );
    }
    if (row.profileAbsentAfterUninstall !== true) {
      failures.push(
        `row "${row.rowId}" must set profileAbsentAfterUninstall to true`,
      );
    }
  }
}

// Rows that assert a machine-observable outcome which a bare "pass" cannot
// carry. The install row must state that no admin elevation was required, and
// the update row must state that the installed version still launched; a row
// that omits the field is a claim, not evidence, so the field is required.
function checkRowEvidence(row, failures) {
  if (row.command === COMMAND_WITH_NO_ELEVATION) {
    if (row.adminElevationRequired !== false) {
      failures.push(
        `row "${row.rowId}" does not prove a per-user install: adminElevationRequired must be false`,
      );
    }
  }
  if (row.command === COMMAND_WITH_UPDATE_FALLBACK) {
    if (row.fallbackLaunchedInstalledVersion !== true) {
      failures.push(
        `row "${row.rowId}" does not prove the fallback: fallbackLaunchedInstalledVersion must be true`,
      );
    }
  }
}

function checkEnvironment(row, expected, failures) {
  const environment = row.environment;
  if (
    environment === null ||
    typeof environment !== "object" ||
    environment.id !== expected.id ||
    environment.family !== "Windows" ||
    environment.release !== expected.release ||
    environment.architecture !== "x64" ||
    !Number.isInteger(environment.build) ||
    environment.build < expected.minimumBuild ||
    (expected.maximumBuild !== undefined &&
      environment.build > expected.maximumBuild)
  ) {
    failures.push(
      `row "${row.rowId}" has unsupported OS fixture; expected ${expected.id} Windows ${expected.release} x64 build ${expected.minimumBuild}${expected.maximumBuild === undefined ? " or later" : `-${expected.maximumBuild}`}`,
    );
  }
}

function validate(index, expectedVersion) {
  const failures = [];
  if (index === null || typeof index !== "object" || Array.isArray(index)) {
    return ["evidence index must be a JSON object"];
  }
  if (index.schemaVersion !== SCHEMA_VERSION) {
    failures.push(`schemaVersion must be "${SCHEMA_VERSION}"`);
  }
  if (typeof index.synthetic !== "boolean") {
    failures.push(
      `"synthetic" must be present as a JSON boolean; found ${JSON.stringify(index.synthetic)} ` +
        "(an index that omits it would record a pass as real machine evidence)",
    );
  }
  if (
    !isPlaceholder(String(expectedVersion)) &&
    !CANDIDATE_VERSION_PATTERN.test(String(expectedVersion))
  ) {
    failures.push(
      `candidate version argument must be a semantic version; found "${expectedVersion}"`,
    );
  }
  if (index.candidateVersion !== expectedVersion) {
    failures.push(
      `candidate version must be "${expectedVersion}"; found "${index.candidateVersion}"`,
    );
  }
  if (!Array.isArray(index.rows)) {
    return [...failures, "evidence index rows must be an array"];
  }
  const artifactRoot = path.resolve(
    path.dirname(index.__indexPath),
    typeof index.artifactRoot === "string" ? index.artifactRoot : "",
  );
  if (isPlaceholder(index.artifactRoot)) {
    failures.push(`artifactRoot "${index.artifactRoot}" is unfilled`);
  } else if (!fs.existsSync(artifactRoot)) {
    failures.push(`artifactRoot "${index.artifactRoot}" does not exist`);
  } else if (!fs.statSync(artifactRoot).isDirectory()) {
    failures.push(`artifactRoot "${index.artifactRoot}" is not a directory`);
  }
  const rows = new Map();
  for (const row of index.rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      failures.push("evidence index contains a non-object row");
      continue;
    }
    if (isPlaceholder(row.rowId)) {
      failures.push("evidence index contains an unfilled rowId");
      continue;
    }
    if (rows.has(row.rowId)) {
      failures.push(`row "${row.rowId}" is duplicated`);
      continue;
    }
    rows.set(row.rowId, row);
  }
  for (const environment of REQUIRED_ENVIRONMENTS) {
    for (const command of REQUIRED_COMMANDS) {
      const expectedRowId = rowId(environment.id, command);
      const row = rows.get(expectedRowId);
      if (row === undefined) {
        failures.push(`missing required row "${expectedRowId}"`);
        continue;
      }
      checkEnvironment(row, environment, failures);
      if (row.candidateVersion !== expectedVersion) {
        failures.push(
          `row "${expectedRowId}" is stale: candidate version "${row.candidateVersion}" does not match "${expectedVersion}"`,
        );
      }
      if (isPlaceholder(row.command)) {
        failures.push(`row "${expectedRowId}" has unfilled command`);
      }
      if (row.command !== command) {
        failures.push(`row "${expectedRowId}" command must be "${command}"`);
      }
      for (const tool of [
        "node",
        "npm",
        "electron",
        "electronBuilder",
        "verifier",
      ]) {
        if (isPlaceholder(row.toolVersions?.[tool])) {
          failures.push(
            `row "${expectedRowId}" has unfilled toolVersions.${tool}`,
          );
        }
      }
      if (
        row.execution !== "executed" ||
        row.observedResult !== "pass" ||
        row.exitCode !== 0
      ) {
        failures.push(
          `row "${expectedRowId}" is not a passing execution (execution=${JSON.stringify(row.execution)}, result=${JSON.stringify(row.observedResult)}, exitCode=${JSON.stringify(row.exitCode)})`,
        );
      }
      checkArtifact(
        artifactRoot,
        row.artifactPath,
        { rowId: expectedRowId },
        "artifact",
        failures,
      );
      if (command === COMMAND_WITH_INSTALLER) {
        checkArtifactCompleteness(row, artifactRoot, failures);
      }
      checkInteraction(row, artifactRoot, failures);
      checkRowEvidence(row, failures);
    }
  }
  return failures;
}

function main(argv) {
  const [indexPath, candidateVersion, ...extra] = argv;
  if (
    extra.length > 0 ||
    isPlaceholder(indexPath) ||
    isPlaceholder(candidateVersion)
  ) {
    return report([
      "usage: node scripts/verify-delivery-matrix.cjs <evidence-index.json> <candidate-version>",
    ]);
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.__indexPath = path.resolve(indexPath);
  } catch (error) {
    return report([
      `cannot read evidence index "${indexPath}": ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const failures = validate(index, candidateVersion);
  if (failures.length > 0) {
    return report(failures);
  }
  const synthetic = index.synthetic === true;
  const record = {
    status: "pass",
    generator: "scripts/verify-delivery-matrix.cjs",
    schemaVersion: SCHEMA_VERSION,
    candidateVersion,
    synthetic,
    environments: REQUIRED_ENVIRONMENTS.map((environment) => environment.id),
    rowsVerified: REQUIRED_ENVIRONMENTS.length * REQUIRED_COMMANDS.length,
  };
  process.stdout.write(
    `[verify:delivery-matrix] PASS ${record.rowsVerified} required candidate-bound rows verified for ${candidateVersion}` +
      `${synthetic ? " (SYNTHETIC control, not machine evidence)" : ""}\n`,
  );
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return 0;
}

module.exports = {
  COMMAND_WITH_INSTALLER,
  COMMAND_WITH_PROFILE,
  COMMAND_WITH_SHORTCUT,
  REQUIRED_COMMANDS,
  REQUIRED_ENVIRONMENTS,
  SCHEMA_VERSION,
  checkArtifact,
  isPlaceholder,
  resolveArtifact,
  rowId,
  validate,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `[verify:delivery-matrix] FAIL unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
