"use strict";

// Chain runner for the test suites.
//
// Design decisions, all measured on this workspace:
//   * Suite files are discovered by walking `test/**/*.test.mjs`; no shell
//     glob is involved (a Node 24 glob that matches nothing exits 0 with
//     "tests 0", which would silently green-light an empty suite).
//   * Every suite file belongs to the `unit` chain EXCEPT files under
//     `test/electron/`, which belong to the `electron` chain. A new test area
//     is therefore picked up with no edit to any script.
//   * Three zero-test guards: no suite files at all, a selected chain that
//     matches no file, and (after the run) a TAP summary with `# tests N`
//     where N > 0 plus no enumerated file reported as a bare vacuous
//     `# Subtest:` entry. `node --test` reports such a file as a PASSING test,
//     and on Windows it escapes the path separators, so both sides are
//     normalized by stripping every backslash before comparing.
//   * `--runner-timeout=<ms>` bounds the whole run and kills the process tree
//     so a hung Electron binary or npm fixture can never hang CI forever.

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const TEST_DIRECTORY = path.join(REPOSITORY_ROOT, "test");
const ELECTRON_CHAIN_SEGMENT = "electron";
const CHAINS = ["unit", "electron"];

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

// `node --test` escapes Windows path separators in TAP subtest names
// (`test\\preflight\\x.test.mjs`), so both sides must be compared with every
// path separator removed. Stripping only backslashes is not enough: the
// enumerated side must not be posix-normalized first, or one side keeps `/`
// while the other has none, and the guard silently never fires.
function normalizeSuiteName(value) {
  return value.replace(/[\\/]/g, "");
}

function describe(files) {
  if (files.length === 0) {
    return "  (none)";
  }
  return files
    .map((file) => `  - ${toPosix(path.relative(REPOSITORY_ROOT, file))}`)
    .join("\n");
}

function discoverSuiteFiles() {
  if (!fs.existsSync(TEST_DIRECTORY)) {
    return [];
  }
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        files.push(fullPath);
      }
    }
  };
  walk(TEST_DIRECTORY);
  return files.sort();
}

function selectChain(files, chain) {
  return files.filter((file) => {
    const segments = path.relative(TEST_DIRECTORY, file).split(path.sep);
    const isElectron = segments[0].toLowerCase() === ELECTRON_CHAIN_SEGMENT;
    return chain === "electron" ? isElectron : !isElectron;
  });
}

/**
 * A suite file that declares no tests is reported by `node --test` as a bare
 * `# Subtest: <path>` entry that is counted as a passing test. Detect that:
 * any TAP subtest name that equals one of the enumerated suite files is a
 * vacuous file, because a file that actually declares tests reports the test
 * names, not its own path.
 */
function findVacuousSuiteFiles(output, selectedFiles) {
  const displayNameByNormalized = new Map();
  for (const file of selectedFiles) {
    const displayName = toPosix(path.relative(REPOSITORY_ROOT, file));
    displayNameByNormalized.set(normalizeSuiteName(displayName), displayName);
  }
  const vacuous = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*# Subtest: (.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const displayName = displayNameByNormalized.get(
      normalizeSuiteName(match[1].trim()),
    );
    if (displayName !== undefined && !vacuous.includes(displayName)) {
      vacuous.push(displayName);
    }
  }
  return vacuous;
}

function killProcessTree(pid) {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

function finishRun(
  chain,
  selectedFiles,
  output,
  exitCode,
  timedOut,
  timeoutMs,
) {
  process.stdout.write(output);
  if (!output.endsWith("\n")) {
    process.stdout.write("\n");
  }
  if (timedOut) {
    process.stderr.write(
      `[run-tests] FAIL the ${chain} chain exceeded its ${timeoutMs}ms budget; the runner killed the process tree\n`,
    );
    return 1;
  }
  const summary = /^# tests (\d+)$/m.exec(output);
  if (summary === null) {
    process.stderr.write(
      `[run-tests] FAIL the ${chain} chain produced no TAP "# tests N" summary; refusing to report a green run\n`,
    );
    return 1;
  }
  const testCount = Number(summary[1]);
  if (testCount === 0) {
    process.stderr.write(
      `[run-tests] FAIL the ${chain} chain reported zero tests; refusing to report a green run\n`,
    );
    return 1;
  }
  const vacuous = findVacuousSuiteFiles(output, selectedFiles);
  if (vacuous.length > 0) {
    process.stderr.write(
      `[run-tests] FAIL these suite files declared no tests: ${vacuous.join(", ")}\n`,
    );
    return 1;
  }
  if (exitCode !== 0) {
    process.stderr.write(
      `[run-tests] FAIL the ${chain} chain exited with code ${exitCode}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `[run-tests] ${chain} chain passed ${testCount} tests across ${selectedFiles.length} files\n`,
  );
  return 0;
}

function runChain(chain, selectedFiles, runnerTimeoutMs) {
  return new Promise((resolve) => {
    const args = [
      "--test-reporter=tap",
      "--test",
      ...selectedFiles.map((file) => path.relative(REPOSITORY_ROOT, file)),
    ];
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const timer =
      runnerTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
          }, runnerTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      output += `\n[run-tests] failed to spawn the test runner: ${error.message}\n`;
    });
    child.on("close", (exitCode) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(
        finishRun(
          chain,
          selectedFiles,
          output,
          exitCode,
          timedOut,
          runnerTimeoutMs,
        ),
      );
    });
  });
}

function parseArguments(argv) {
  const [chain, ...rest] = argv;
  if (!CHAINS.includes(chain)) {
    return {
      error: `chain must be one of ${CHAINS.join(", ")} (received "${chain ?? ""}")`,
    };
  }
  let runnerTimeoutMs;
  for (const token of rest) {
    const match = /^--runner-timeout=(\d+)$/.exec(token);
    if (match === null) {
      return { error: `unknown option "${token}"` };
    }
    runnerTimeoutMs = Number(match[1]);
    if (!Number.isFinite(runnerTimeoutMs) || runnerTimeoutMs <= 0) {
      return {
        error: "the runner timeout must be a positive millisecond count",
      };
    }
  }
  return { chain, runnerTimeoutMs };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const suiteFiles = discoverSuiteFiles();
  if (parsed.error !== undefined) {
    process.stderr.write(`[run-tests] FAIL ${parsed.error}\n`);
    process.stderr.write(
      `[run-tests] discovered suite files:\n${describe(suiteFiles)}\n`,
    );
    return 1;
  }
  if (suiteFiles.length === 0) {
    process.stderr.write(
      `[run-tests] FAIL no *.test.mjs suite files were found under ${toPosix(path.relative(REPOSITORY_ROOT, TEST_DIRECTORY))}/\n`,
    );
    return 1;
  }
  const selectedFiles = selectChain(suiteFiles, parsed.chain);
  if (selectedFiles.length === 0) {
    process.stderr.write(
      `[run-tests] FAIL the ${parsed.chain} chain matched no suite file; discovered files:\n${describe(suiteFiles)}\n`,
    );
    return 1;
  }
  return runChain(parsed.chain, selectedFiles, parsed.runnerTimeoutMs);
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
