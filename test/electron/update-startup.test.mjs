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
// The suite then runs REAL multi-launch recovery, which is the half that a
// single launch cannot observe: the launcher quits before the installer can
// report anything, so the outcome of a handoff can only be resolved by a
// LATER process. The `update-recovery` fixture scenario drives the REAL
// classification and the REAL bilingual guidance against the REAL per-user
// directory convention, so the sequences below are measured, not simulated:
//
//   confirmed  - a completed install's receipt: the attempt is confirmed, the
//                pending installer copy is reclaimed, and nothing is shown.
//   dead       - an installer that aborted or died and never relaunched: the
//                attempt is classified, the bilingual repair guidance is
//                shown, and the copy is reclaimed. Once only.
//
// No network beyond 127.0.0.1 is touched: the feed is an injected transport.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_NOW,
  INSTALLER_ASSET_NAME,
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

const RELEASE_PAGE =
  "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest";

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

/** The nonce the real launcher handed to the installer. */
function handoffNonceOf(result) {
  assert.equal(result.spawnCalls.length, 1, "expected exactly one handoff");
  const match = /^--update-nonce=([0-9a-f]{32})$/.exec(
    result.spawnCalls[0].arguments[2],
  );
  assert.ok(
    match,
    `unexpected nonce argument: ${result.spawnCalls[0].arguments[2]}`,
  );
  return match[1];
}

/** Writes what a completed NSIS install publishes before it relaunches. */
function publishSuccessMarker(result, nonce) {
  fs.mkdirSync(result.statusDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(result.statusDirectory, `success-${nonce}.json`),
    JSON.stringify({ nonce }),
    "utf8",
  );
}

/** Runs the next launch's real terminal-outcome recovery, in Electron. */
async function runRecovery(environment, { launchNonce, currentVersion } = {}) {
  const args = [
    "--scenario=update-recovery",
    `--base-dir=${environment.baseDirectory}`,
  ];
  if (launchNonce !== undefined) {
    args.push(`--launch-nonce=${launchNonce}`);
  }
  if (currentVersion !== undefined) {
    args.push(`--current-version=${currentVersion}`);
  }
  const run = await spawnFixtureHost(args);
  assertCleanRun(run);
  return recordOf(run.records, "update-recovery-result");
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
  // The handoff invariant, pinned exactly rather than by count: the single
  // pending directory IS the attempt's nonce directory, it still holds the
  // exact signed asset the installer was just told to run, and the attempt is
  // durably recorded against that same nonce. The copy must survive HERE
  // because the installer executes from that path; the follow-up tests below
  // pin that a later launch reclaims it once the outcome is terminal.
  const nonce = handoffNonceOf(result);
  assert.deepEqual(result.pendingDirectories, [nonce]);
  assert.deepEqual(fs.readdirSync(result.pendingRoot), [nonce]);
  assert.deepEqual(fs.readdirSync(path.join(result.pendingRoot, nonce)), [
    INSTALLER_ASSET_NAME,
  ]);
  assert.deepEqual(result.statusEntries, [`attempt-${nonce}.json`]);
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
  assert.deepEqual(
    result.statusEntries,
    [],
    "an update that never reached a handoff records no attempt",
  );
  assert.ok(
    server.requests.length >= 1,
    "the installed app must load its page",
  );
});

test("a completed install is confirmed and its installer copy is reclaimed", async (t) => {
  // The handoff alone cannot say anything about the outcome: this process is
  // quitting and the installer is detached. The NEXT launch, carrying the
  // nonce, resolves the attempt from the installer's own receipt — and that is
  // the same launch that reclaims the installer copy, which nothing ever
  // deleted before.
  const environment = prepareEnvironment(t);
  const { run } = await runUpdateScenario(t, environment);
  assertCleanRun(run);
  const handoff = recordOf(run.records, "update-result");
  const nonce = handoffNonceOf(handoff);
  publishSuccessMarker(handoff, nonce);

  const recovery = await runRecovery(environment, {
    launchNonce: nonce,
    currentVersion: "2.0.0",
  });

  assert.equal(recovery.classification.kind, "confirmed");
  assert.equal(recovery.classification.nonce, nonce);
  assert.deepEqual(recovery.before.pendingDirectories, [nonce]);
  assert.deepEqual(
    recovery.after.pendingDirectories,
    [],
    "the terminal outcome deletes the pending installer",
  );
  assert.deepEqual(
    recovery.after.statusEntries,
    [],
    "the one-shot receipt and the attempt record are both consumed",
  );
  assert.equal(recovery.dialogCount, 0, "a confirmed update must not nag");
  assert.equal(
    recovery.windowCount,
    0,
    "recovery resolves before any window exists",
  );
});

test("an installer that never relaunched is classified and its copy is reclaimed", async (t) => {
  // D1 in a real Electron main process. The installer aborted in `.onInit` (a
  // bad handoff, or the parent-wait timeout) or died part-way through
  // replacing files: it published no receipt and never relaunched the app, and
  // the old version is still installed. The next ordinary launch must classify
  // that attempt and show the bilingual repair / manual-download guidance,
  // instead of leaving a half-installed tree silently accepted forever.
  const environment = prepareEnvironment(t);
  const { run } = await runUpdateScenario(t, environment);
  assertCleanRun(run);
  const handoff = recordOf(run.records, "update-result");
  const nonce = handoffNonceOf(handoff);
  assert.deepEqual(handoff.statusEntries, [`attempt-${nonce}.json`]);
  assert.deepEqual(
    handoff.pendingDirectories,
    [nonce],
    "the copy is still on disk at handoff: the installer runs from it",
  );

  const recovery = await runRecovery(environment);

  assert.equal(recovery.launchNonce, null);
  assert.equal(recovery.classification.kind, "repair");
  assert.equal(recovery.classification.reason, "unconfirmed");
  assert.deepEqual(recovery.classification.nonces, [nonce]);
  assert.equal(recovery.windowCount, 0);
  assert.equal(recovery.dialogCount, 1, "the user is told exactly once");
  assert.match(recovery.dialogTitle, /[\u4e00-\u9fff]/);
  assert.match(recovery.dialogTitle, /[A-Za-z]{4,}/);
  assert.match(recovery.dialogMessage, /[\u4e00-\u9fff]/);
  assert.match(recovery.dialogMessage, /cannot be confirmed/);
  assert.match(recovery.dialogMessage, /manually/);
  assert.equal(recovery.dialogDetail, RELEASE_PAGE, "the manual download page");
  assert.equal(recovery.dialogButtons.length, 2);
  assert.deepEqual(
    recovery.externalCalls,
    [],
    "the default button is not the download page",
  );
  assert.doesNotMatch(
    recovery.dialogMessage,
    /rolled back|restored|已回復|已還原/,
    "a repair message must never promise recovery the design cannot provide",
  );
  assert.deepEqual(
    recovery.after.pendingDirectories,
    [],
    "a copy no installer will ever run again is reclaimed",
  );
  assert.deepEqual(recovery.after.statusEntries, [], "the record is consumed");

  const again = await runRecovery(environment);
  assert.deepEqual(
    again.classification,
    { kind: "none" },
    "one failed attempt produces at most one message, ever",
  );
  assert.equal(again.dialogCount, 0);
});

test("consecutive handoffs leave no installer copy behind", async (t) => {
  // D2 as it was measured: two successful handoffs used to leave two nonce
  // directories, each holding a full installer copy, with nothing ever
  // reclaiming them. Each attempt is now reclaimed by the launch that resolves
  // it, so the pending tree is empty again.
  const environment = prepareEnvironment(t);
  const first = await runUpdateScenario(t, environment);
  assertCleanRun(first.run);
  const firstNonce = handoffNonceOf(
    recordOf(first.run.records, "update-result"),
  );

  const second = await runUpdateScenario(t, environment);
  assertCleanRun(second.run);
  const secondHandoff = recordOf(second.run.records, "update-result");
  const secondNonce = handoffNonceOf(secondHandoff);

  assert.notEqual(firstNonce, secondNonce);
  assert.deepEqual(
    secondHandoff.pendingDirectories,
    [firstNonce, secondNonce].sort(),
    "each handoff leaves exactly its own copy before any outcome",
  );
  for (const nonce of [firstNonce, secondNonce]) {
    publishSuccessMarker(secondHandoff, nonce);
  }

  for (const nonce of [firstNonce, secondNonce]) {
    const recovery = await runRecovery(environment, {
      launchNonce: nonce,
      currentVersion: "2.0.0",
    });
    assert.equal(recovery.classification.kind, "confirmed");
    assert.equal(recovery.classification.nonce, nonce);
  }

  const last = await runRecovery(environment);
  assert.deepEqual(
    last.after.pendingDirectories,
    [],
    "the pending tree is empty again: no copy is orphaned",
  );
  assert.deepEqual(last.after.statusEntries, []);
  assert.equal(last.dialogCount, 0, "nothing is left to report");
});
