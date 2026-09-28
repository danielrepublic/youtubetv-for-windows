import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const pinnedVersion = manifest.devDependencies.electron;

// This suite is part of the `electron` chain: it may only run on a Windows x64
// machine that has already completed `npm run clean-install`. It must never
// import the `electron` package: node_modules/electron/index.js lazily calls
// getElectronPath(), which downloads ~150 MB when path.txt is missing, so an
// import would turn a test-collection module load into a network download.

test("the pinned Electron dependency is an exact version", () => {
  assert.match(pinnedVersion, /^\d+\.\d+\.\d+$/);
});

test("the Electron package ships no install script, so the root postinstall hook is load-bearing", () => {
  const electronManifestPath = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "package.json",
  );
  assert.ok(
    fs.existsSync(electronManifestPath),
    "node_modules/electron/package.json is missing: run `npm run clean-install` first",
  );
  const electronManifest = JSON.parse(
    fs.readFileSync(electronManifestPath, "utf8"),
  );
  assert.equal(
    electronManifest.scripts,
    undefined,
    "electron 44.4.5 must still declare no lifecycle script for this test to remain meaningful",
  );
  assert.equal(
    manifest.scripts.postinstall,
    "node node_modules/electron/install.js",
  );
});

test("the pinned Electron binary reports its version", () => {
  const pathTxtPath = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "path.txt",
  );
  assert.ok(
    fs.existsSync(pathTxtPath),
    "node_modules/electron/path.txt is missing: The Electron binary is not installed. Run `npm run clean-install` " +
      "(or `node node_modules/electron/install.js`) on a Windows x64 machine with a desktop session, then re-run " +
      "`npm run test:electron`.",
  );
  const binaryName = fs.readFileSync(pathTxtPath, "utf8").trim();
  const binaryPath = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "dist",
    binaryName,
  );
  assert.ok(
    fs.existsSync(binaryPath),
    `the Electron binary is missing at ${binaryPath}`,
  );
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  assert.equal(
    result.error,
    undefined,
    `failed to run the Electron binary: ${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `electron --version exited with ${result.status}: ${result.stderr ?? ""}`,
  );
  assert.equal(result.stdout.trim(), `v${pinnedVersion}`);
});
