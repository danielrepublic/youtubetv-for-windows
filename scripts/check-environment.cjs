"use strict";

// Fail-closed toolchain preflight for the pinned Windows x64 workspace.
//
// This script implements its own tiny, dependency-free range checker instead of
// depending on the `semver` package: any range token it cannot parse makes the
// check fail closed, so a typo in `engines` breaks the build instead of
// silently disabling the gate.
//
// Division of labor (measured on npm 11.17.0):
//   * `.npmrc` `engine-strict=true` is npm's own gate and aborts `npm ci`
//     before dependency reification.
//   * This script is ALSO wired as the root `preinstall` hook for visibility,
//     but npm reifies before root lifecycle scripts run, so the hook is a
//     message, not an ordering gate. `clean-install` therefore runs the
//     preflight as its first command as well.
//
// The failure message is exactly "Installation is blocked." and deliberately
// does not claim the failure happens "before dependencies are installed".

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPOSITORY_ROOT, "package.json");

const KNOWN_OPERATORS = new Set([">=", "<=", ">", "<"]);

function trimToUndefined(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parseVersion(rawVersion) {
  const trimmed = trimToUndefined(rawVersion);
  if (trimmed === undefined) {
    return undefined;
  }
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? undefined : match[4],
  };
}

function compareParsed(left, right) {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1;
  }
  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1;
  }
  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1;
  }
  return 0;
}

/**
 * Fail-closed checker for comparator ranges such as ">=24.19.0 <25.0.0".
 *
 * Returns false for every input it cannot fully parse: exact pins, carets,
 * tildes, ">=" with a space before the version, a version with a prerelease
 * suffix, or a non-string range. Only "and" semantics are supported: every
 * whitespace-separated comparator must hold.
 */
function satisfiesRange(rawVersion, rawRange) {
  const version = parseVersion(rawVersion);
  if (version === undefined || version.prerelease !== undefined) {
    return false;
  }
  if (typeof rawRange !== "string") {
    return false;
  }
  const tokens = rawRange
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return false;
  }
  for (const token of tokens) {
    const match = /^(>=|<=|>|<)(\d+)\.(\d+)\.(\d+)$/.exec(token);
    if (match === null || !KNOWN_OPERATORS.has(match[1])) {
      return false;
    }
    const boundary = {
      major: Number(match[2]),
      minor: Number(match[3]),
      patch: Number(match[4]),
      prerelease: undefined,
    };
    const order = compareParsed(version, boundary);
    const operator = match[1];
    if (operator === ">=" && order < 0) {
      return false;
    }
    if (operator === ">" && order <= 0) {
      return false;
    }
    if (operator === "<=" && order > 0) {
      return false;
    }
    if (operator === "<" && order >= 0) {
      return false;
    }
  }
  return true;
}

function runCommand(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    if (result.error || result.status !== 0) {
      return undefined;
    }
    return typeof result.stdout === "string" ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the npm version from, in order:
 *   1. BOOTSTRAP_NPM_VERSION (test/CI override)
 *   2. npm_execpath (set by npm when this script runs as a lifecycle command)
 *   3. ComSpec on Windows, plain `npm` elsewhere
 *
 * The `run` seam exists so tests can exercise every branch deterministically.
 */
function detectNpmVersion(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const override = trimToUndefined(env.BOOTSTRAP_NPM_VERSION);
  if (override !== undefined) {
    return override;
  }
  const npmExecPath = trimToUndefined(env.npm_execpath);
  if (npmExecPath !== undefined) {
    const fromExecPath = trimToUndefined(
      run(process.execPath, [npmExecPath, "--version"], { env }),
    );
    if (fromExecPath !== undefined) {
      return fromExecPath;
    }
  }
  if (platform === "win32") {
    const comSpec = trimToUndefined(env.ComSpec) ?? "cmd.exe";
    return trimToUndefined(
      run(comSpec, ["/d", "/s", "/c", "npm --version"], { env }),
    );
  }
  return trimToUndefined(run("npm", ["--version"], { env }));
}

function detectNodeVersion(env = process.env) {
  return trimToUndefined(env.BOOTSTRAP_NODE_VERSION) ?? process.version;
}

function detectPlatform(env = process.env) {
  return trimToUndefined(env.BOOTSTRAP_PLATFORM) ?? process.platform;
}

function detectArchitecture(env = process.env) {
  return trimToUndefined(env.BOOTSTRAP_ARCH) ?? process.arch;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

function collectFailures(manifest, versions) {
  const failures = [];
  const nodeRange = manifest.engines?.node;
  const npmRange = manifest.engines?.npm;
  if (!satisfiesRange(versions.node, nodeRange)) {
    failures.push(
      `Node.js ${versions.node ?? "unknown"} does not satisfy engines.node "${nodeRange ?? "missing"}"`,
    );
  }
  if (!satisfiesRange(versions.npm, npmRange)) {
    failures.push(
      `npm ${versions.npm ?? "unknown"} does not satisfy engines.npm "${npmRange ?? "missing"}"`,
    );
  }
  const supportedPlatforms = Array.isArray(manifest.os) ? manifest.os : [];
  if (!supportedPlatforms.includes(versions.platform)) {
    failures.push(
      `platform ${versions.platform} is not supported (expected ${supportedPlatforms.join(", ") || "win32"})`,
    );
  }
  const supportedArchitectures = Array.isArray(manifest.cpu)
    ? manifest.cpu
    : [];
  if (!supportedArchitectures.includes(versions.architecture)) {
    failures.push(
      `architecture ${versions.architecture} is not supported (expected ${supportedArchitectures.join(", ") || "x64"})`,
    );
  }
  return failures;
}

function main() {
  const manifest = readManifest();
  if (manifest === undefined) {
    process.stderr.write(`[preflight] FAIL cannot read ${MANIFEST_PATH}\n`);
    process.stderr.write("Installation is blocked.\n");
    return 1;
  }
  const versions = {
    node: detectNodeVersion(process.env),
    npm: detectNpmVersion({ env: process.env }),
    platform: detectPlatform(process.env),
    architecture: detectArchitecture(process.env),
  };
  const failures = collectFailures(manifest, versions);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`[preflight] FAIL ${failure}\n`);
    }
    process.stderr.write("Installation is blocked.\n");
    return 1;
  }
  process.stdout.write(
    `[preflight] node ${versions.node} is inside ${manifest.engines.node}\n`,
  );
  process.stdout.write(
    `[preflight] npm ${versions.npm} is inside ${manifest.engines.npm}\n`,
  );
  process.stdout.write(
    `[preflight] platform ${versions.platform}/${versions.architecture} is supported (windows x64 only)\n`,
  );
  process.stdout.write(
    `[preflight] host ${os.release()} on ${os.platform()}\n`,
  );
  process.stdout.write("[preflight] OK\n");
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  compareParsed,
  detectArchitecture,
  detectNodeVersion,
  detectNpmVersion,
  detectPlatform,
  main,
  parseVersion,
  satisfiesRange,
  trimToUndefined,
};
