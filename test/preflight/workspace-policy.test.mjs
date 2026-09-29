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
const lockfile = require(path.join(repositoryRoot, "package-lock.json"));
const { satisfiesRange } = require(
  path.join(repositoryRoot, "scripts", "check-environment.cjs"),
);

const FORBIDDEN_DEPENDENCY_PATTERNS = [
  /webview2/i,
  /(^|[/@-])wpf([/@-]|$)/i,
  /(^|[/@-])uwp([/@-]|$)/i,
  /msix/i,
  /appx/i,
  /windows-sdk/i,
  /^@microsoft\//i,
  /electron-updater/i,
];

const BUILD_TARGETS_ALLOWED = new Set(["dir", "nsis"]);

test("the toolchain is declared as a supported major line, not an exact patch", () => {
  assert.match(manifest.engines.node, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  assert.match(manifest.engines.npm, /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  assert.equal(manifest.packageManager, "npm@11.17.0");
});

test("a patch or minor bump of Node.js and npm is inside the supported toolchain", () => {
  assert.equal(satisfiesRange("24.19.1", manifest.engines.node), true);
  assert.equal(satisfiesRange("24.20.0", manifest.engines.node), true);
  assert.equal(satisfiesRange("24.18.9", manifest.engines.node), false);
  assert.equal(satisfiesRange("25.0.0", manifest.engines.node), false);
  assert.equal(satisfiesRange("24.20.0-beta.1", manifest.engines.node), false);
  assert.equal(satisfiesRange("11.17.1", manifest.engines.npm), true);
  assert.equal(satisfiesRange("11.18.0", manifest.engines.npm), true);
  assert.equal(satisfiesRange("11.16.9", manifest.engines.npm), false);
  assert.equal(satisfiesRange("12.0.0", manifest.engines.npm), false);
  assert.equal(satisfiesRange("11.18.0-rc.1", manifest.engines.npm), false);
});

test("every declared dependency is an exact registry version", () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  const pins = Object.entries(manifest.devDependencies);
  assert.ok(pins.length >= 9, "the pinned toolchain must stay declared");
  for (const [name, version] of pins) {
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/,
      `${name} must be an exact pin, received ${version}`,
    );
  }
  for (const section of ["optionalDependencies", "peerDependencies"]) {
    assert.equal(manifest[section], undefined, `${section} must stay empty`);
  }
});

test("the workspace has exactly one lockfile", () => {
  const lockFileNames = fs
    .readdirSync(repositoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /lock/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(lockFileNames, ["package-lock.json"]);
  for (const competing of [
    "yarn.lock",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "bun.lockb",
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, competing)),
      false,
      `${competing} must not exist`,
    );
  }
});

test("the lockfile is v3 and its root entry agrees with the manifest", () => {
  assert.equal(lockfile.lockfileVersion, 3);
  const rootEntry = lockfile.packages[""];
  assert.ok(rootEntry, "the lockfile must contain a root package entry");
  assert.deepEqual(rootEntry.devDependencies, manifest.devDependencies);
  assert.deepEqual(rootEntry.engines, manifest.engines);
  assert.deepEqual(rootEntry.os, manifest.os);
  assert.deepEqual(rootEntry.cpu, manifest.cpu);
  assert.equal(
    rootEntry.hasInstallScript,
    true,
    "npm marks the root lifecycle hooks in the lockfile",
  );
});

test("the install script allowlist covers exactly the dependencies that ship one", () => {
  const allowlisted = Object.keys(manifest.allowScripts ?? {}).sort();
  const installing = [
    ...new Set(
      Object.keys(lockfile.packages)
        .filter(
          (key) =>
            key !== "" && lockfile.packages[key].hasInstallScript === true,
        )
        .map((key) => key.split("node_modules/").pop()),
    ),
  ].sort();
  assert.deepEqual(allowlisted, installing);
  for (const [name, allowed] of Object.entries(manifest.allowScripts ?? {})) {
    assert.equal(allowed, true, `${name} must be explicitly allowed`);
  }
});

test("the Electron binary is fetched by the root postinstall hook", () => {
  assert.equal(
    manifest.scripts.postinstall,
    "node node_modules/electron/install.js",
  );
  assert.match(manifest.devDependencies.electron, /^\d+\.\d+\.\d+$/);
  const electronLock = lockfile.packages["node_modules/electron"];
  assert.ok(electronLock, "electron must be present in the lockfile");
  assert.equal(electronLock.version, manifest.devDependencies.electron);
  assert.equal(
    electronLock.hasInstallScript,
    undefined,
    "electron 44.4.5 declares no install script; the root postinstall hook is what fetches the binary",
  );
});

test("the toolchain gate is wired into both install paths", () => {
  assert.equal(
    manifest.scripts.preinstall,
    "node scripts/check-environment.cjs",
  );
  assert.equal(
    manifest.scripts["clean-install"],
    "npm run clean && npm run preflight && npm ci",
  );
  const npmrc = fs.readFileSync(path.join(repositoryRoot, ".npmrc"), "utf8");
  assert.match(npmrc, /^engine-strict=true$/m);
});

test("the headless chain and the desktop chain are separate contracts", () => {
  assert.equal(
    manifest.scripts["test:unit"],
    "node scripts/run-tests.cjs unit",
  );
  assert.equal(
    manifest.scripts["test:electron"],
    "node scripts/run-tests.cjs electron",
  );
  assert.equal(
    manifest.scripts["verify:static"],
    "npm run preflight && npm run lint && npm run format:check && npm run typecheck && npm run test:unit",
  );
  assert.equal(
    manifest.scripts["verify:windows"],
    "npm run test:electron && npm run package && npm run verify:artifacts",
  );
  assert.equal(
    manifest.scripts.verify,
    "npm run verify:static && npm run verify:windows",
  );
});

test("the test runner never relies on a shell glob", () => {
  for (const scriptName of [
    "test:unit",
    "test:electron",
    "verify:static",
    "verify:windows",
  ]) {
    assert.doesNotMatch(
      manifest.scripts[scriptName],
      /\*/,
      `${scriptName} must not rely on a shell glob`,
    );
  }
  const runnerSource = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "run-tests.cjs"),
    "utf8",
  );
  assert.match(
    runnerSource,
    /readdirSync/,
    "the runner discovers suite files itself",
  );
});

test("no dependency introduces WebView2, WPF/UWP/MSIX, or a Microsoft SDK", () => {
  const names = [
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(lockfile.packages),
  ];
  const offenders = names.filter((name) =>
    FORBIDDEN_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(name)),
  );
  assert.deepEqual([...new Set(offenders)], []);
});

test("electron-updater is never a dependency of this workspace", () => {
  const names = [
    ...Object.keys(manifest.devDependencies),
    ...Object.keys(lockfile.packages),
  ];
  assert.deepEqual(
    names.filter((name) => /electron-updater/i.test(name)),
    [],
  );
});

test("packaging targets Windows x64 only, with no portable or non-x64 output", () => {
  assert.ok(manifest.build, "package.json must declare build configuration");
  assert.equal(manifest.build.directories.output, "release-output");
  const targets = manifest.build.win?.target ?? [];
  assert.ok(targets.length > 0, "a Windows target must be declared");
  for (const target of targets) {
    assert.ok(
      BUILD_TARGETS_ALLOWED.has(target.target),
      `${target.target} must stay inside the Windows-only target set`,
    );
    assert.deepEqual(target.arch, ["x64"]);
  }
  assert.doesNotMatch(
    manifest.scripts.package,
    /--ia32|--arm64|portable|\bzip\b|\bmsi\b/i,
  );
  assert.match(manifest.scripts.package, /--win/);
  assert.match(manifest.scripts.package, /--x64/);
  assert.doesNotMatch(
    manifest.scripts.package,
    /--dir/,
    "the --dir flag emits only the unpacked directory and skips the NSIS installer",
  );
});

test("the Electron upgrade policy is documented alongside the pinned version", () => {
  const documentation = fs.readFileSync(
    path.join(repositoryRoot, "docs", "developer-bootstrap.md"),
    "utf8",
  );
  assert.ok(
    documentation.includes(manifest.devDependencies.electron),
    "the documented Electron version must match the manifest pin",
  );
  assert.match(documentation, /upgrade/i);
  assert.match(documentation, /test:electron/);
  assert.match(
    documentation,
    /--version/,
    "the documented check is the binary version comparison",
  );
});

test("a fresh clone checks out LF text so the formatter gate is stable", () => {
  const attributesPath = path.join(repositoryRoot, ".gitattributes");
  assert.ok(
    fs.existsSync(attributesPath),
    "a repo without .gitattributes clones as CRLF on autocrlf=true machines",
  );
  const attributes = fs.readFileSync(attributesPath, "utf8");
  assert.match(attributes, /^\* text=auto eol=lf$/m);
});

test("the sandboxed preload is emitted as CommonJS behind a marker package.json", () => {
  assert.equal(manifest.type, "module");
  const preloadConfig = require(
    path.join(repositoryRoot, "tsconfig.preload.json"),
  );
  assert.equal(preloadConfig.compilerOptions.module, "commonjs");
  assert.ok(
    manifest.scripts.build.includes("mark-preload-cjs.cjs"),
    "the build chain must run the CommonJS marker step",
  );
  const buildConfig = require(path.join(repositoryRoot, "tsconfig.build.json"));
  assert.deepEqual(buildConfig.exclude, ["src/preload.ts"]);
  assert.ok(fs.existsSync(path.join(repositoryRoot, "src", "preload.ts")));
});
