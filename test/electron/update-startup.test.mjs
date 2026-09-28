// Real-Electron pre-window update ordering suite.
//
// The fixture host drives the REAL `startHost` composition and the REAL
// `runPreWindowStage` state machine inside a real Electron main process, with
// the fake release feed injected at the composition root (dependency
// injection, not a runtime override). Two scenarios are covered:
//
//   ready  - a fully verified installer: NO window may exist, the detached
//            spawn must carry the exact /S + parent-PID + nonce arguments,
//            and the stage must request the quit.
//   failed - a signature-tampered feed: the bilingual guidance is shown and
//            the installed version still launches in a window.
//
// No network beyond 127.0.0.1 is touched: the feed is an injected transport.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_NOW,
  INSTALLER_ASSET_URL,
  INSTALLER_REDIRECT_URL,
  MANIFEST_ASSET_URL,
  RELEASES_LATEST_URL,
  SIGNATURE_ASSET_URL,
  buildScenario,
} from "../update/fixture-helpers.mjs";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

function tamperBase64(base64) {
  const raw = Buffer.from(base64, "base64");
  raw[0] ^= 0x01;
  return raw.toString("base64");
}

function prepareEnvironment(t, { tampered = false } = {}) {
  const fixture = buildScenario();
  const feedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-feed-"));
  const baseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ytvw-electron-"),
  );
  t.after(() => {
    fixture.cleanup();
    fs.rmSync(feedDirectory, { recursive: true, force: true });
    fs.rmSync(baseDirectory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(feedDirectory, "installer.bin"),
    fixture.installerBytes,
  );
  fs.writeFileSync(
    path.join(feedDirectory, "feed.json"),
    JSON.stringify({
      urls: {
        releases: RELEASES_LATEST_URL,
        manifest: MANIFEST_ASSET_URL,
        signature: SIGNATURE_ASSET_URL,
        installer: INSTALLER_ASSET_URL,
        installerRedirect: INSTALLER_REDIRECT_URL,
      },
      release: fixture.release,
      manifestText: fixture.manifestText,
      signatureBase64: tampered
        ? tamperBase64(fixture.signatureBase64)
        : fixture.signatureBase64,
      installerFile: "installer.bin",
      keyring: fixture.keyring,
      currentVersion: fixture.currentVersion,
      now: FIXED_NOW,
    }),
  );
  return { fixture, feedDirectory, baseDirectory };
}

async function runUpdateScenario(t, environment) {
  const server = await startFixtureServer(t);
  const run = await spawnFixtureHost([
    "--scenario=update",
    `--feed-dir=${environment.feedDirectory}`,
    `--base-dir=${environment.baseDirectory}`,
    `--page-url=${server.url}`,
  ]);
  return { run, server };
}

test("update-ready hands off the installer with no window ever created", async (t) => {
  const environment = prepareEnvironment(t);
  const { run, server } = await runUpdateScenario(t, environment);

  assertCleanRun(run);
  const result = recordOf(run.records, "update-result");
  assert.equal(result.hostStarted, false, "the host must not start");
  assert.equal(result.windowCount, 0, "no BrowserWindow may exist");
  assert.equal(result.quitRequested, true, "the stage must request the quit");
  assert.equal(result.dialogCount, 0);

  assert.equal(result.spawnCalls.length, 1);
  const spawn = result.spawnCalls[0];
  assert.equal(spawn.arguments[0], "/S");
  assert.match(spawn.arguments[1], /^--update-parent-pid=5150$/);
  assert.match(spawn.arguments[2], /^--update-nonce=[0-9a-f]{32}$/);
  assert.deepEqual(spawn.options, {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  assert.equal(
    fs.existsSync(spawn.installerPath),
    true,
    "the verified installer must be on disk when the installer runs",
  );
  assert.equal(path.basename(spawn.installerPath).endsWith(".exe"), true);
  assert.deepEqual(
    result.stageReports.map((record) => record.event),
    ["update-spawned"],
  );
  assert.equal(result.pendingDirectories.length, 1);
  // The fake feed is injected: the local page server was never touched
  // because no window and no load happened.
  assert.deepEqual(server.requests, []);
});

test("a failed verification shows bilingual guidance and still launches the app", async (t) => {
  const environment = prepareEnvironment(t, { tampered: true });
  const { run, server } = await runUpdateScenario(t, environment);

  assertCleanRun(run);
  const result = recordOf(run.records, "update-result");
  assert.equal(result.hostStarted, true, "the installed version must start");
  assert.equal(result.windowCount, 1, "exactly one window for the app");
  assert.equal(result.quitRequested, false);
  assert.equal(result.spawnCalls.length, 0);
  assert.equal(result.dialogCount, 1);
  assert.match(result.dialogTitle, /更新失敗|Update failed/);
  assert.match(result.dialogMessage, /[\u4e00-\u9fff]/);
  assert.match(result.dialogMessage, /installed version will start/);
  assert.deepEqual(
    result.stageReports.map(
      (record) => `${record.event}:${record.updateCode ?? ""}`,
    ),
    ["update-check-completed:invalid-signature"],
  );
  assert.deepEqual(result.pendingDirectories, []);
  assert.ok(
    server.requests.length >= 1,
    "the installed app must load its page",
  );
});
