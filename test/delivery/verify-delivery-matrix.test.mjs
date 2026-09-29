// These are intentionally SYNTHETIC verifier controls, never clean-machine
// evidence. They drive the command-line boundary against isolated TEMP trees.
//
// The contract under test is the verifier's own: a release verdict is refused
// unless every required row is present, candidate-bound, artifact-backed, and
// passing. Assertions therefore key on the FAILING ROW ID (the thing the
// diagnostic must name) plus the defect keyword, not on incidental wording.

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
const verifierPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-delivery-matrix.cjs",
);
const { REQUIRED_COMMANDS, REQUIRED_ENVIRONMENTS, SCHEMA_VERSION } = require(
  verifierPath,
);
const candidateVersion = "0.1.0";
const x64Pe = "C:\\Windows\\System32\\notepad.exe";
const x86Pe = "C:\\Windows\\SysWOW64\\where.exe";

function expectedEnvironment(expected) {
  return {
    id: expected.id,
    family: "Windows",
    release: expected.release,
    build: expected.minimumBuild,
    architecture: "x64",
  };
}

function createFixture(t) {
  assert.ok(fs.existsSync(x64Pe), `missing Windows x64 PE fixture: ${x64Pe}`);
  assert.ok(fs.existsSync(x86Pe), `missing Windows x86 PE fixture: ${x86Pe}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-delivery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = [];
  for (const expected of REQUIRED_ENVIRONMENTS) {
    const environment = expectedEnvironment(expected);
    for (const command of REQUIRED_COMMANDS) {
      const fileStem = `${environment.id}-${command.replaceAll(
        /[^a-z0-9]+/gi,
        "-",
      )}`;
      const artifactPath = `logs/${fileStem}.txt`;
      fs.mkdirSync(path.join(root, "logs"), { recursive: true });
      fs.writeFileSync(
        path.join(root, artifactPath),
        `SYNTHETIC ${command}\n`,
        "utf8",
      );
      const row = {
        rowId: `${environment.id}:${command}`,
        candidateVersion,
        environment,
        command,
        toolVersions: {
          node: process.version,
          npm: "11.17.0",
          electron: "44.4.5",
          electronBuilder: "26.15.3",
          verifier: "delivery-matrix-evidence/v1",
        },
        execution: "executed",
        observedResult: "pass",
        exitCode: 0,
        artifactPath,
      };
      if (command === "artifact completeness") {
        fs.mkdirSync(path.join(root, "release-output", "win-unpacked"), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(root, "release-output", "installer.exe"),
          "synthetic installer",
          "utf8",
        );
        fs.copyFileSync(
          x64Pe,
          path.join(root, "release-output", "win-unpacked", "app.exe"),
        );
        row.installerPath = "release-output/installer.exe";
        row.applicationExecutablePath = "release-output/win-unpacked/app.exe";
      }
      if (command === "start-menu shortcut launch") {
        fs.mkdirSync(path.join(root, "shortcuts"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "shortcuts", `${environment.id}.lnk`),
          "synthetic shortcut",
          "utf8",
        );
        row.shortcutPath = `shortcuts/${environment.id}.lnk`;
      }
      if (command === "uninstaller profile deletion") {
        row.profilePath = `profiles/${environment.id}`;
        row.profileAbsentAfterUninstall = true;
      }
      if (command === "standard-user install no-admin-elevation") {
        row.adminElevationRequired = false;
      }
      if (command === "update-failure fallback") {
        row.fallbackLaunchedInstalledVersion = true;
      }
      rows.push(row);
    }
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    candidateVersion,
    synthetic: true,
    artifactRoot: ".",
    rows,
  };
  const indexPath = path.join(root, "evidence-index.json");
  const save = () => fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");
  save();
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [verifierPath, indexPath, candidateVersion],
      {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      },
    );
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  };
  const row = (command, environmentId = "windows-10-1809-x64") =>
    rows.find((entry) => entry.rowId === `${environmentId}:${command}`);
  return { index, root, row, run, save, indexPath };
}

test("SYNTHETIC complete matrix is accepted only with all 30 candidate-bound rows", (t) => {
  const fixture = createFixture(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /"synthetic": true/);
  assert.match(result.output, /30 required candidate-bound rows/);
});

test("missing installer names the artifact-completeness row", (t) => {
  const fixture = createFixture(t);
  fs.rmSync(
    path.join(fixture.root, fixture.row("artifact completeness").installerPath),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:artifact completeness"),
    result.output,
  );
  assert.match(result.output, /installer/i);
});

test("wrong architecture names the artifact-completeness row", (t) => {
  const fixture = createFixture(t);
  fs.copyFileSync(
    x86Pe,
    path.join(
      fixture.root,
      fixture.row("artifact completeness").applicationExecutablePath,
    ),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:artifact completeness"),
    result.output,
  );
  assert.match(result.output, /wrong-architecture artifact/);
});

test("absent shortcut names the shortcut-launch row", (t) => {
  const fixture = createFixture(t);
  fs.rmSync(
    path.join(
      fixture.root,
      fixture.row("start-menu shortcut launch").shortcutPath,
    ),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:start-menu shortcut launch"),
    result.output,
  );
  assert.match(result.output, /shortcut/i);
});

test("stale profile names the uninstaller-profile-deletion row", (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(
    path.join(
      fixture.root,
      fixture.row("uninstaller profile deletion").profilePath,
    ),
    {
      recursive: true,
    },
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:uninstaller profile deletion"),
    result.output,
  );
  assert.match(result.output, /stale profile/);
});

test("unsupported OS fixture names the affected matrix row", (t) => {
  const fixture = createFixture(t);
  fixture.row("npm run preflight").environment.build = 7601;
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:npm run preflight"),
    result.output,
  );
  assert.match(result.output, /unsupported OS fixture/);
});

test("a missing required row fails closed and names that row", (t) => {
  const fixture = createFixture(t);
  fixture.index.rows = fixture.index.rows.filter(
    (entry) => entry.rowId !== "windows-11-current-x64:artifact completeness",
  );
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-11-current-x64:artifact completeness"),
    result.output,
  );
  assert.match(result.output, /missing required row/);
});

test("a duplicated row id fails closed", (t) => {
  const fixture = createFixture(t);
  fixture.index.rows.push({ ...fixture.row("npm run lint") });
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /npm run lint" is duplicated/);
});

test("a non-existent artifactRoot fails closed", (t) => {
  const fixture = createFixture(t);
  fixture.index.artifactRoot = "missing-evidence-root";
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /artifactRoot/);
});

test("a stale candidate row and missing command artifact fail closed", (t) => {
  const fixture = createFixture(t);
  const row = fixture.row("npm run lint");
  row.candidateVersion = "0.0.9";
  fs.rmSync(path.join(fixture.root, row.artifactPath));
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:npm run lint"),
    result.output,
  );
  assert.match(result.output, /is stale/);
  assert.match(result.output, /artifact/i);
});

test("a row that cannot prove no admin elevation fails closed", (t) => {
  const fixture = createFixture(t);
  fixture.row(
    "standard-user install no-admin-elevation",
  ).adminElevationRequired = true;
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes(
      "windows-10-1809-x64:standard-user install no-admin-elevation",
    ),
    result.output,
  );
  assert.match(result.output, /adminElevationRequired/);
});

test("a row that cannot prove the update fallback launched fails closed", (t) => {
  const fixture = createFixture(t);
  const row = fixture.row("update-failure fallback");
  delete row.fallbackLaunchedInstalledVersion;
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.output.includes("windows-10-1809-x64:update-failure fallback"),
    result.output,
  );
  assert.match(result.output, /fallbackLaunchedInstalledVersion/);
});

test("an unexecuted placeholder row cannot pass", (t) => {
  const fixture = createFixture(t);
  const row = fixture.row("update-failure fallback");
  row.execution = "unexecuted";
  row.observedResult = "not-run";
  row.exitCode = -1;
  row.toolVersions.electron = "TBD";
  fixture.save();
  const result = fixture.run();
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /update-failure fallback" has unfilled toolVersions\.electron/,
  );
  assert.match(
    result.output,
    /update-failure fallback" is not a passing execution/,
  );
});
