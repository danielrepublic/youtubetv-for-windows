// Task-7 verifier fixtures.
//
// Drives byte-identical copies of `scripts/verify-artifacts.cjs` against
// TEMP fake repos, so every failure path of the installer asset contract is
// proven end to end: the exact command line, exit code, and FAIL text —
// never the predicate in isolation. Nothing is created inside the real repo.
//
// Conventions inherited from the bootstrap hardening lane: the script
// resolves its repository root from its own location, so each fixture holds
// a copy of the script beside a fixture `package.json`; the application
// executable is a REAL signed Windows PE (`notepad.exe` for x64,
// `SysWOW64\where.exe` for x86), never fabricated bytes.

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
const realManifest = require(path.join(repositoryRoot, "package.json"));
const verifierSource = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "verify-artifacts.cjs"),
);

const X64_SYSTEM_EXE = "C:\\Windows\\System32\\notepad.exe";
const X86_SYSTEM_EXE = "C:\\Windows\\SysWOW64\\where.exe";

function fixtureManifest() {
  return {
    name: realManifest.name,
    version: realManifest.version,
    scripts: { package: realManifest.scripts.package },
    build: {
      productName: realManifest.build.productName,
      directories: { output: "release-output" },
      win: JSON.parse(JSON.stringify(realManifest.build.win)),
      nsis: JSON.parse(JSON.stringify(realManifest.build.nsis)),
    },
  };
}

function installerName() {
  return `${realManifest.build.productName}-${realManifest.version}-x64.exe`;
}

function applicationName() {
  return `${realManifest.build.productName}.exe`;
}

// Builds a TEMP fake repo holding a byte-identical verifier copy, a fixture
// manifest, and whatever `release-output/` tree `populate` creates. Runs the
// verifier there and returns its exact exit code and output.
function runFixture(t, manifest, populate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-verify-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "scripts", "verify-artifacts.cjs"),
    verifierSource,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, "scripts", "verify-artifacts.cjs")),
    verifierSource,
    "the fixture must run a byte-identical verifier copy",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  populate(root);
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-artifacts.cjs")],
    { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30000 },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function validTree(root) {
  const output = path.join(root, "release-output");
  const unpacked = path.join(output, "win-unpacked");
  fs.mkdirSync(unpacked, { recursive: true });
  fs.copyFileSync(X64_SYSTEM_EXE, path.join(unpacked, applicationName()));
  // A per-machine build carries electron-builder's elevation helper inside
  // the packaged directory; the verifier requires it by exact path.
  const resources = path.join(unpacked, "resources");
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, "elevate.exe"), "elevate-bytes");
  fs.writeFileSync(path.join(output, installerName()), "installer-bytes");
  fs.writeFileSync(
    path.join(output, `${installerName()}.blockmap`),
    "blockmap-bytes",
  );
  fs.writeFileSync(path.join(output, "latest.yml"), "version: 0.1.0\n");
  fs.writeFileSync(path.join(output, "builder-debug.yml"), "debug: true\n");
}

test("a valid installer plus x64 application passes and names both", (t) => {
  const run = runFixture(t, fixtureManifest(), validTree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /\[verify:artifacts\] PASS/);
  assert.ok(run.output.includes(installerName()), run.output);
  assert.ok(
    run.output.includes(`win-unpacked/${applicationName()}`),
    run.output,
  );
});

test("a missing installer fails with the versioned name", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.rmSync(path.join(root, "release-output", installerName()));
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /missing the versioned installer/);
  assert.ok(run.output.includes(installerName()), run.output);
});

test("a misnamed installer fails closed", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.rmSync(path.join(root, "release-output", installerName()));
    fs.writeFileSync(
      path.join(
        root,
        "release-output",
        `${realManifest.build.productName}-${realManifest.version}-ia32.exe`,
      ),
      "installer-bytes",
    );
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /is not the expected versioned installer/);
});

test("an extra executable fails closed by path", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.writeFileSync(
      path.join(root, "release-output", "win-unpacked", "elevate.exe"),
      "helper-bytes",
    );
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /unexpected executable/);
  assert.ok(run.output.includes("elevate.exe"), run.output);
});

test("a missing per-machine elevation helper fails closed", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.rmSync(
      path.join(
        root,
        "release-output",
        "win-unpacked",
        "resources",
        "elevate.exe",
      ),
    );
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /expected exactly three executables/);
  assert.ok(run.output.includes("resources/elevate.exe"), run.output);
});

test("a non-x64 output directory fails", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.mkdirSync(path.join(root, "release-output", "win-ia32-unpacked"), {
      recursive: true,
    });
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /unsupported release directory "win-ia32-unpacked"/);
});

test("an x86 application executable fails the PE arch guard", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.rmSync(
      path.join(root, "release-output", "win-unpacked", applicationName()),
    );
    fs.copyFileSync(
      X86_SYSTEM_EXE,
      path.join(root, "release-output", "win-unpacked", applicationName()),
    );
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /Machine must be 0x8664/);
});

test("a weakened packaging target fails before any file check", (t) => {
  const manifest = fixtureManifest();
  manifest.build.win.target = [{ target: "dir", arch: ["x64"] }];
  const run = runFixture(t, manifest, validTree);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /build\.win\.target must be exactly/);
});

test("a stray top-level file fails closed", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    validTree(root);
    fs.writeFileSync(
      path.join(root, "release-output", "portable-helper.zip"),
      "x",
    );
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /pinned builder byproduct/);
  assert.ok(run.output.includes("portable-helper.zip"), run.output);
});

test("a missing unpacked directory fails honestly", (t) => {
  const run = runFixture(t, fixtureManifest(), (root) => {
    fs.mkdirSync(path.join(root, "release-output"), { recursive: true });
    fs.writeFileSync(path.join(root, "release-output", installerName()), "x");
  });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /missing the "win-unpacked" directory/);
});
