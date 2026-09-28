import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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

const FIXTURE_FILES = [
  "package.json",
  "package-lock.json",
  ".npmrc",
  path.join("scripts", "check-environment.cjs"),
];

function createFixture(label) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `opencode-install-gate-${label}-`),
  );
  for (const relativePath of FIXTURE_FILES) {
    const destination = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relativePath), destination);
  }
  return fixtureRoot;
}

function runInFixture(fixtureRoot, command, environment = {}) {
  return spawnSync(command, {
    cwd: fixtureRoot,
    shell: true,
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, ...environment },
  });
}

function assertUnreified(fixtureRoot) {
  assert.equal(
    fs.existsSync(path.join(fixtureRoot, "node_modules")),
    false,
    "no dependency may be reified after the toolchain gate refuses",
  );
}

test("the documented clean-install command refuses an unsupported Node.js before reification", (t) => {
  const fixtureRoot = createFixture("node");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const result = runInFixture(fixtureRoot, manifest.scripts["clean-install"], {
    BOOTSTRAP_NODE_VERSION: "20.18.0",
    BOOTSTRAP_NPM_VERSION: "11.17.0",
  });
  assert.notEqual(
    result.status,
    0,
    "clean-install must fail for an unsupported Node.js",
  );
  assert.match(result.stderr, /Installation is blocked\./);
  assert.match(result.stderr, /20\.18\.0/);
  assertUnreified(fixtureRoot);
});

test("the documented clean-install command refuses an unsupported npm before reification", (t) => {
  const fixtureRoot = createFixture("npm");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const result = runInFixture(fixtureRoot, manifest.scripts["clean-install"], {
    BOOTSTRAP_NODE_VERSION: "24.19.0",
    BOOTSTRAP_NPM_VERSION: "9.8.1",
  });
  assert.notEqual(
    result.status,
    0,
    "clean-install must fail for an unsupported npm",
  );
  assert.match(result.stderr, /Installation is blocked\./);
  assert.match(result.stderr, /9\.8\.1/);
  assertUnreified(fixtureRoot);
});

test("npm engine-strict refuses an unsupported toolchain before reification", (t) => {
  const fixtureRoot = createFixture("engine-strict");
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const impossibleEngines = {
    node: ">=99.0.0 <100.0.0",
    npm: ">=11.17.0 <12.0.0",
  };
  // Keep the manifest and the lockfile root in sync, so the only thing npm can
  // fail on is the engines gate.
  for (const relativePath of ["package.json", "package-lock.json"]) {
    const filePath = path.join(fixtureRoot, relativePath);
    const contents = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (relativePath === "package.json") {
      contents.engines = impossibleEngines;
    } else {
      contents.packages[""].engines = impossibleEngines;
    }
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(contents, null, 2)}\n`,
      "utf8",
    );
  }
  const result = runInFixture(fixtureRoot, "npm ci --ignore-scripts");
  assert.notEqual(
    result.status,
    0,
    "npm ci must fail under an unsupported engines range",
  );
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /EBADENGINE|Unsupported engine|not compatible with your version/i,
  );
  assertUnreified(fixtureRoot);
});
