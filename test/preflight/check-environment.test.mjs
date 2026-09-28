import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const scriptPath = path.join(
  repositoryRoot,
  "scripts",
  "check-environment.cjs",
);
const manifest = require(path.join(repositoryRoot, "package.json"));
const { detectNpmVersion, satisfiesRange } = require(scriptPath);

function runPreflight(overrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
}

function withSupportedToolchain(overrides = {}) {
  return runPreflight({
    BOOTSTRAP_NODE_VERSION: "24.19.0",
    BOOTSTRAP_NPM_VERSION: "11.17.0",
    BOOTSTRAP_PLATFORM: "win32",
    BOOTSTRAP_ARCH: "x64",
    ...overrides,
  });
}

test("accepts the supported Node, npm, win32, and x64 fixture", () => {
  const result = withSupportedToolchain();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[preflight\] OK/);
  assert.match(result.stderr, /^$/);
});

test("accepts a patch and a minor bump of the supported toolchain", () => {
  const patch = withSupportedToolchain({
    BOOTSTRAP_NODE_VERSION: "24.19.1",
    BOOTSTRAP_NPM_VERSION: "11.17.7",
  });
  assert.equal(patch.status, 0, patch.stderr);
  const minor = withSupportedToolchain({
    BOOTSTRAP_NODE_VERSION: "24.20.0",
    BOOTSTRAP_NPM_VERSION: "11.18.0",
  });
  assert.equal(minor.status, 0, minor.stderr);
});

test("rejects an old Node.js LTS line", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_NODE_VERSION: "22.11.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /22\.11\.0/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects a newer Node.js major", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_NODE_VERSION: "25.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /25\.0\.0/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects a Node.js line below the verified floor", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_NODE_VERSION: "24.18.9" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /24\.18\.9/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects an unsupported npm major", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_NPM_VERSION: "10.9.5" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /10\.9\.5/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects a non-Windows platform", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_PLATFORM: "linux" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /platform linux is not supported/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects an x86 architecture", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_ARCH: "ia32" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /architecture ia32 is not supported/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("rejects an ARM64 architecture", () => {
  const result = withSupportedToolchain({ BOOTSTRAP_ARCH: "arm64" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /architecture arm64 is not supported/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("detects the npm version when the fixture does not supply one", () => {
  // First with whatever npm_execpath the parent process provides (the path a
  // real `npm run` lifecycle sets), then with it removed so the Windows
  // ComSpec branch is the only remaining probe.
  const inherited = runPreflight({ BOOTSTRAP_NPM_VERSION: undefined });
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(inherited.stdout, /\[preflight\] npm 11\.\d+\.\d+/);
  const withoutNpmExecPath = runPreflight({
    BOOTSTRAP_NPM_VERSION: undefined,
    npm_execpath: undefined,
  });
  assert.equal(withoutNpmExecPath.status, 0, withoutNpmExecPath.stderr);
  assert.match(withoutNpmExecPath.stdout, /\[preflight\] npm 11\.\d+\.\d+/);
});

test("reports an unknown npm version when the probe cannot run", () => {
  const viaFunction = detectNpmVersion({
    env: {},
    platform: "linux",
    run: () => undefined,
  });
  assert.equal(viaFunction, undefined);
  const result = withSupportedToolchain({
    BOOTSTRAP_NPM_VERSION: undefined,
    npm_execpath: "C:\\does-not-exist\\npm-cli.js",
    ComSpec: "C:\\does-not-exist\\cmd.exe",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm unknown does not satisfy/);
  assert.match(result.stderr, /Installation is blocked\./);
});

test("selects the npm probe that matches the environment", () => {
  const calls = [];
  const fakeRun = (command, args) => {
    calls.push({ command, args });
    return "11.17.0";
  };
  assert.equal(
    detectNpmVersion({ env: {}, platform: "linux", run: fakeRun }),
    "11.17.0",
  );
  assert.equal(calls.at(-1).command, "npm");
  assert.deepEqual(calls.at(-1).args, ["--version"]);
  assert.equal(
    detectNpmVersion({
      env: { ComSpec: "C:\\fake\\cmd.exe" },
      platform: "win32",
      run: fakeRun,
    }),
    "11.17.0",
  );
  assert.equal(calls.at(-1).command, "C:\\fake\\cmd.exe");
  assert.deepEqual(calls.at(-1).args, ["/d", "/s", "/c", "npm --version"]);
  assert.equal(
    detectNpmVersion({
      env: { npm_execpath: "C:\\fake\\npm-cli.js" },
      platform: "linux",
      run: fakeRun,
    }),
    "11.17.0",
  );
  assert.equal(calls.at(-1).command, process.execPath);
  assert.deepEqual(calls.at(-1).args, ["C:\\fake\\npm-cli.js", "--version"]);
});

test("the range checker admits the supported line and nothing else", () => {
  const { node: nodeRange, npm: npmRange } = manifest.engines;
  assert.equal(satisfiesRange("24.19.0", nodeRange), true);
  assert.equal(satisfiesRange("24.19.1", nodeRange), true);
  assert.equal(satisfiesRange("24.20.0", nodeRange), true);
  assert.equal(satisfiesRange("24.18.9", nodeRange), false);
  assert.equal(satisfiesRange("25.0.0", nodeRange), false);
  assert.equal(satisfiesRange("24.20.0-beta.1", nodeRange), false);
  assert.equal(satisfiesRange("11.17.0", npmRange), true);
  assert.equal(satisfiesRange("11.18.3", npmRange), true);
  assert.equal(satisfiesRange("11.16.9", npmRange), false);
  assert.equal(satisfiesRange("12.0.0", npmRange), false);
});

test("the range checker fails closed on a range it cannot parse", () => {
  const range = ">=24.19.0 <25.0.0";
  for (const badRange of [
    "24.19.0",
    "^24.19.0",
    "~24.19.0",
    ">=v24.19.0",
    ">= 24.19.0",
    ">=24.19.0 || <25.0.0",
    "",
  ]) {
    assert.equal(
      satisfiesRange("24.19.0", badRange),
      false,
      `range "${badRange}" must fail closed`,
    );
  }
  assert.equal(satisfiesRange("24.19.0", undefined), false);
  assert.equal(satisfiesRange("not-a-version", range), false);
  assert.equal(satisfiesRange("24.19.0-beta.1", range), false);
});
