// Additive adversarial controls for the delivery-matrix verifier.
//
// This file is a COMPLEMENT to `verify-delivery-matrix.test.mjs`, not a
// replacement: it pins the defect classes that the fail-closed hardening pass
// closed, so a future refactor cannot silently reopen them. It exists because
// six predicates were once absent or satisfiable by a bare boolean:
//
//   1. `synthetic` was never validated, so an index that omitted it produced a
//      pass record reading `"synthetic": false` - a machine-evidence claim
//      nobody made.
//   2. The uninstaller row accepted `profileAbsentAfterUninstall: true` with no
//      `profilePath` at all, i.e. a checkbox instead of evidence.
//   3. A placeholder `profilePath` was equally acceptable.
//   4. `fs.existsSync` is also true for a directory, so a directory named as
//      the installer passed as "the installer exists".
//   5. A zero-byte file passed as an artifact.
//   6. The uninstaller row accepted a `profilePath` naming ANY absent tree, so
//      a per-user %LOCALAPPDATA% path - a tree the uninstaller never removes -
//      read as evidence that the machine data root was deleted.
//
// Assertions deliberately key on the FAILING ROW ID plus a broad class keyword,
// never on incidental wording, so the suite stays honest when diagnostics are
// reworded without weakening: the teeth are `status === 1`, which only an
// actually fail-closed verifier can produce. A verifier that accepts any of
// these fixtures returns 0 and fails here.
//
// EVERY fixture in this file is SYNTHETIC. Nothing here is clean-machine
// evidence, and the one fixture allowed to pass is labelled `synthetic: true`
// inside the index it writes. The real matrix rows remain UNEXECUTED: no
// Windows 10 1809 x64 or Windows 11 x64 VM exists on this machine.

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
const schemaPath = path.join(
  repositoryRoot,
  "release-evidence-schema",
  "delivery-matrix-evidence.schema.json",
);
const { REQUIRED_COMMANDS, REQUIRED_ENVIRONMENTS, SCHEMA_VERSION } = require(
  verifierPath,
);
const candidateVersion = "0.1.0";
const amd64PeFixture = "C:\\Windows\\System32\\notepad.exe";
const i386PeFixture = "C:\\Windows\\SysWOW64\\where.exe";
const requiredRowCount =
  REQUIRED_ENVIRONMENTS.length * REQUIRED_COMMANDS.length;

// Builds a COMPLETE synthetic index that the current contract accepts. If the
// contract gains a new required field this baseline stops passing, which is the
// intended loud failure: an out-of-date positive control must never read green.
function createSyntheticMatrix(t) {
  assert.ok(
    fs.existsSync(amd64PeFixture),
    `missing Windows x64 PE fixture: ${amd64PeFixture}`,
  );
  assert.ok(
    fs.existsSync(i386PeFixture),
    `missing Windows x86 PE fixture: ${i386PeFixture}`,
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-matrix-adv-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const writeFile = (relativePath, contents) => {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
    return relativePath;
  };

  const rows = [];
  for (const expected of REQUIRED_ENVIRONMENTS) {
    const environment = {
      id: expected.id,
      family: "Windows",
      release: expected.release,
      build: expected.minimumBuild,
      architecture: "x64",
    };
    for (const command of REQUIRED_COMMANDS) {
      const stem = `${environment.id}-${command.replaceAll(
        /[^a-z0-9]+/gi,
        "-",
      )}`;
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
          verifier: SCHEMA_VERSION,
        },
        execution: "executed",
        observedResult: "pass",
        exitCode: 0,
        artifactPath: writeFile(`logs/${stem}.txt`, `SYNTHETIC ${command}\n`),
      };
      if (command === "machine-wide install with-uac-elevation") {
        row.adminElevationRequired = true;
      }
      if (command === "start-menu shortcut launch") {
        row.shortcutPath = writeFile(
          `shortcuts/${environment.id}.lnk`,
          "synthetic shortcut\n",
        );
      }
      if (command === "uninstaller profile deletion") {
        // The machine data tree is machine-wide, so both environment rows cite
        // the SAME ProgramData root; there is no per-environment tree to name.
        row.profilePath = "ProgramData/youtubetv-for-windows";
        row.profileAbsentAfterUninstall = true;
      }
      if (command === "artifact completeness") {
        row.installerPath = writeFile(
          "release-output/installer.exe",
          "synthetic installer\n",
        );
        const applicationExecutable = path.join(
          root,
          "release-output",
          "win-unpacked",
          "app.exe",
        );
        fs.mkdirSync(path.dirname(applicationExecutable), { recursive: true });
        fs.copyFileSync(amd64PeFixture, applicationExecutable);
        row.applicationExecutablePath = "release-output/win-unpacked/app.exe";
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

  const runWithVersion = (version) => {
    const result = spawnSync(
      process.execPath,
      [verifierPath, indexPath, version],
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

  const row = (command, environmentId = "windows-10-1809-x64") => {
    const found = rows.find(
      (entry) => entry.rowId === `${environmentId}:${command}`,
    );
    assert.ok(found, `fixture is missing row ${environmentId}:${command}`);
    return found;
  };

  return {
    index,
    root,
    row,
    rows,
    save,
    run: () => runWithVersion(candidateVersion),
    runWithVersion,
  };
}

// Asserts the verifier refused, named the offending row, and mentioned the
// defect class. `rowId` is undefined for index-level defects, which have no row.
function assertFailClosed(result, { rowId, keyword }) {
  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.output, /\[verify:delivery-matrix\] PASS/);
  if (rowId !== undefined) {
    assert.ok(
      result.output.includes(rowId),
      `diagnostic did not name row ${rowId}:\n${result.output}`,
    );
  }
  assert.match(result.output, keyword);
}

test("SYNTHETIC positive control: the complete synthetic matrix is accepted", (t) => {
  const matrix = createSyntheticMatrix(t);
  const result = matrix.run();
  assert.equal(result.status, 0, result.output);
  // The green verdict must be labelled synthetic in the record and the line.
  assert.match(result.output, /"synthetic": true/);
  assert.match(result.output, /\(SYNTHETIC control, not machine evidence\)/);
  assert.match(result.output, new RegExp(`${requiredRowCount} required`));
});

// The schema's `rows.minItems` is a second, independent statement of the row
// count. When the two drift apart, a real 28-row index is rejected by the
// schema (or a 30-row index satisfies it) while the verifier reports a
// different `rowsVerified` in its PASS record, so the published contract and
// the enforced one disagree. Nothing else in the chain compares them.
test("the schema row floor equals the verifier's required row count", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert.equal(
    schema.properties.rows.minItems,
    requiredRowCount,
    "delivery-matrix-evidence.schema.json rows.minItems has drifted from " +
      "REQUIRED_ENVIRONMENTS x REQUIRED_COMMANDS",
  );
});

test("binding is to the exact candidate: the same matrix fails for another version", (t) => {
  const matrix = createSyntheticMatrix(t);
  const other = matrix.runWithVersion("0.2.0");
  assert.equal(other.status, 1, other.output);
  assert.match(other.output, /candidate version must be "0\.2\.0"/);
});

test("an index that omits the synthetic flag cannot produce an evidence claim", (t) => {
  const matrix = createSyntheticMatrix(t);
  delete matrix.index.synthetic;
  matrix.save();
  assertFailClosed(matrix.run(), {
    keyword: /"synthetic".*boolean/,
  });
});

test("a stringly-typed synthetic flag is rejected", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.index.synthetic = "true";
  matrix.save();
  assertFailClosed(matrix.run(), {
    keyword: /"synthetic".*boolean/,
  });
});

test("a bare profile-absence boolean with no named profile is not deletion evidence", (t) => {
  const matrix = createSyntheticMatrix(t);
  const row = matrix.row("uninstaller profile deletion");
  delete row.profilePath;
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:uninstaller profile deletion",
    keyword: /profilePath/,
  });
});

test("a placeholder profile path cannot stand in for a deleted profile", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.row("uninstaller profile deletion").profilePath = "TBD";
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:uninstaller profile deletion",
    keyword: /profilePath/,
  });
});

test("a directory named as the installer is not an installer", (t) => {
  const matrix = createSyntheticMatrix(t);
  const installer = path.join(
    matrix.root,
    matrix.row("artifact completeness").installerPath,
  );
  fs.rmSync(installer);
  fs.mkdirSync(installer);
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:artifact completeness",
    keyword: /installer/,
  });
});

test("a zero-byte application executable is not evidence", (t) => {
  const matrix = createSyntheticMatrix(t);
  fs.writeFileSync(
    path.join(
      matrix.root,
      matrix.row("artifact completeness").applicationExecutablePath,
    ),
    "",
  );
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:artifact completeness",
    keyword: /application executable/,
  });
});

test("a directory cited as a command artifact is rejected", (t) => {
  const matrix = createSyntheticMatrix(t);
  const directory = path.join(matrix.root, "logs", "a-directory");
  fs.mkdirSync(directory);
  matrix.row("npm run typecheck").artifactPath = "logs/a-directory";
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:npm run typecheck",
    keyword: /artifact/,
  });
});

test("a zero-byte command artifact is rejected", (t) => {
  const matrix = createSyntheticMatrix(t);
  fs.writeFileSync(
    path.join(matrix.root, matrix.row("npm run lint").artifactPath),
    "",
  );
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:npm run lint",
    keyword: /artifact/,
  });
});

test("an absent command artifact is rejected", (t) => {
  const matrix = createSyntheticMatrix(t);
  fs.rmSync(
    path.join(matrix.root, matrix.row("npm run format:check").artifactPath),
  );
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:npm run format:check",
    keyword: /artifact/,
  });
});

test("a stale candidate row is rejected", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.row("npm run preflight").candidateVersion = "0.0.9";
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:npm run preflight",
    keyword: /stale/,
  });
});

test("the real, currently-unexecuted delivery state is refused wholesale", (t) => {
  const matrix = createSyntheticMatrix(t);
  // This is what an honest index looks like today: no VM has executed any of
  // the required rows. The verifier must refuse all of them and say why, and it
  // must not emit a PASS line that could be quoted as a delivery verdict.
  for (const row of matrix.rows) {
    row.execution = "unexecuted";
    row.observedResult = "not-run";
    row.exitCode = -1;
  }
  matrix.save();
  const result = matrix.run();
  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.output, /\[verify:delivery-matrix\] PASS/);
  const refusals = result.output.match(/is not a passing execution/g) ?? [];
  assert.equal(refusals.length, requiredRowCount, result.output);
  assert.match(
    result.output,
    /windows-11-current-x64:artifact completeness" is not a passing execution \(execution="unexecuted", result="not-run", exitCode=-1\)/,
  );
});

test("an install row that cannot state elevation behaviour is refused", (t) => {
  const matrix = createSyntheticMatrix(t);
  delete matrix.row("machine-wide install with-uac-elevation")
    .adminElevationRequired;
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:machine-wide install with-uac-elevation",
    keyword: /adminElevationRequired/,
  });
});

// The uninstaller removes one machine-wide tree, so a row that names a per-user
// %LOCALAPPDATA% tree claims deletion of a path nothing in the uninstaller
// touches. Accepting it would let a stale per-user row - the shape this matrix
// had before the machine-wide install - read as current delivery evidence.
test("a per-user %LOCALAPPDATA% profile path is refused", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.row("uninstaller profile deletion").profilePath =
    "LocalAppData/youtubetv-for-windows/users/user/profile";
  matrix.save();
  const result = matrix.run();
  assertFailClosed(result, {
    rowId: "windows-10-1809-x64:uninstaller profile deletion",
    keyword: /wrong data tree/,
  });
  assert.match(
    result.output,
    /%LOCALAPPDATA%/,
    "the diagnostic must say which wrong tree was named",
  );
});

// The machine root is the only shape the uninstaller deletes, so a LEAF inside
// it (`...\users\<key>\profile`) is refused too: the row is a claim about the
// whole tree, and a row about one user's leaf says nothing about the root.
test("a leaf inside the machine data root is refused", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.row("uninstaller profile deletion").profilePath =
    "ProgramData/youtubetv-for-windows/users/user/profile";
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:uninstaller profile deletion",
    keyword: /wrong data tree/,
  });
});

test("an unsupported OS fixture is refused on both environments", (t) => {
  const matrix = createSyntheticMatrix(t);
  matrix.row("npm run lint", "windows-10-1809-x64").environment.build = 15063;
  matrix.row("npm run lint", "windows-11-current-x64").environment.build =
    19045;
  matrix.save();
  const result = matrix.run();
  assertFailClosed(result, {
    rowId: "windows-10-1809-x64:npm run lint",
    keyword: /unsupported OS fixture/,
  });
  assert.ok(
    result.output.includes("windows-11-current-x64:npm run lint"),
    result.output,
  );
});

test("a row outside the required cross-product is refused", (t) => {
  const matrix = createSyntheticMatrix(t);
  // A stale index written before a command was removed still carries that
  // command's rows. The cross-product check is presence-only, so those rows are
  // inert: the verifier used to accept them silently, which let a 30-row index
  // from a superseded contract pass as a current 28-row delivery matrix.
  matrix.rows.push({
    ...matrix.row("npm run lint"),
    rowId: "windows-10-1809-x64:update-failure fallback",
    command: "update-failure fallback",
    fallbackLaunchedInstalledVersion: true,
  });
  matrix.save();
  assertFailClosed(matrix.run(), {
    rowId: "windows-10-1809-x64:update-failure fallback",
    keyword: /is not a required matrix row/,
  });
});
