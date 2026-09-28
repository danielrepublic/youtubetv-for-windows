// The pre-window update state-machine suite.
//
// Every process boundary is injected: transport (no sockets), clock, ETag
// cache, spawner, quit call, dialog presenter, and the release-page opener.
// The suite pins the startup contract that protects the installed version:
//
//   - `up-to-date` / `skipped` launch silently with no UI,
//   - `failed` shows the bilingual guidance and then launches,
//   - `update-ready` is RE-VERIFIED from the pending path immediately before
//     the detached spawn with the exact silent/parent-PID/nonce arguments,
//   - a file tampered after the download decision aborts and the pending
//     directory is deleted,
//   - a spawn failure deletes the pending directory and falls back,
//   - the whole stage is bounded; expiry launches the installed version and
//     reclaims any pending directory the abandoned check creates afterwards,
//   - lock contention is a silent skip that touches no network and no state,
//   - exactly one release request is made per call,
//   - the stage module is Electron-free, so nothing it does can create a
//     window before the decision (the window ordering itself is pinned by
//     test/policy/app-wiring.test.mjs and the Electron fixture suite).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FIXED_NOW,
  INSTALLER_ASSET_NAME,
  INSTALLER_REDIRECT_URL,
  RELEASES_LATEST_URL,
  buildScenario,
  createAbortTransport,
  errorResponse,
  plantLockFile,
  readUpdateState,
} from "../update/fixture-helpers.mjs";

const {
  INSTALLER_SPAWN_OPTIONS,
  installerArguments,
  runPreWindowStage,
  spawnDetachedInstaller,
} = await import("../../src/main/update/startup.ts");
const { successMarkerPath, verifyAndConsumeSuccessMarker } =
  await import("../../src/main/update/relaunch.ts");
const { updateHomePaths } = await import("../../src/main/update/pending.ts");
const { SUPPORT_RELEASE_URL } = await import("../../src/main/dialogs.ts");

const PROFILE_PARENT_NAME = "youtubetv-for-windows";
const PROCESS_ID = 4242;

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(intervalMs);
  }
}

/**
 * Builds the stage seam bundle over an isolated profile parent directory so
 * the update directories are real siblings of `profile` and every artifact is
 * inspectable and disposable.
 */
function createStage(t, fixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-startup-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fixture.cleanup();
  });
  const profileDirectory = path.join(root, PROFILE_PARENT_NAME, "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const updateBase = path.join(root, PROFILE_PARENT_NAME, "updates");
  const paths = updateHomePaths(updateBase);

  const calls = {
    spawn: [],
    unref: [],
    quit: 0,
    dialogs: [],
    downloadPage: 0,
    reports: [],
  };
  let dialogResponse = 1;

  const stage = {
    calls,
    root,
    profileDirectory,
    updateBase,
    paths,
    state: () => readUpdateState(updateBase),
    setDialogResponse(value) {
      dialogResponse = value;
    },
    run(runOverrides = {}) {
      return runPreWindowStage({
        profileDirectory,
        transport: fixture.transport,
        keyring: fixture.keyring,
        version: fixture.currentVersion,
        etagCache: fixture.etagCache,
        now: fixture.now,
        limits: fixture.limits,
        processId: PROCESS_ID,
        spawnInstaller: (installerPath, argumentsList, options) => {
          calls.spawn.push({
            installerPath,
            arguments: [...argumentsList],
            options,
          });
          return {
            ok: true,
            unref: () => {
              calls.unref.push(installerPath);
            },
          };
        },
        requestQuit: () => {
          calls.quit += 1;
        },
        presenter: {
          showMessageBox: async (options) => {
            calls.dialogs.push(options);
            return { response: dialogResponse };
          },
        },
        openDownloadPage: () => {
          calls.downloadPage += 1;
        },
        report: (record) => {
          calls.reports.push(record);
        },
        ...runOverrides,
      });
    },
  };
  return stage;
}

function reportCodes(stage) {
  return stage.calls.reports.map(
    (record) =>
      `${record.event}${record.updateCode ? `:${record.updateCode}` : ""}`,
  );
}

function assertBilingual(dialog) {
  assert.ok(dialog, "expected a dialog");
  assert.match(dialog.title, /更新|\/ /);
  assert.match(
    dialog.message,
    /[\u4e00-\u9fff]/,
    "missing Traditional Chinese",
  );
  assert.match(dialog.message, /[A-Za-z]{4,}/, "missing English");
  assert.equal(dialog.detail, SUPPORT_RELEASE_URL);
  assert.equal(dialog.buttons.length, 2);
}

test("update-ready re-verifies the pending path, spawns detached, and quits", async (t) => {
  const fixture = buildScenario();
  const stage = createStage(t, fixture);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "quit", reason: "update-ready" });
  assert.equal(stage.calls.spawn.length, 1);
  const spawn = stage.calls.spawn[0];
  assert.match(spawn.arguments[1], /^--update-parent-pid=4242$/);
  assert.equal(spawn.arguments[0], "/S");
  const nonceMatch = /^--update-nonce=([0-9a-f]{32})$/.exec(spawn.arguments[2]);
  assert.ok(nonceMatch, `unexpected nonce argument: ${spawn.arguments[2]}`);
  assert.deepEqual(spawn.arguments, installerArguments(4242, nonceMatch[1]));
  assert.deepEqual(spawn.options, INSTALLER_SPAWN_OPTIONS);
  // The re-verified installer lives in the private nonce pending directory.
  assert.equal(
    path.dirname(spawn.installerPath),
    path.join(stage.paths.pendingRoot, nonceMatch[1]),
  );
  assert.equal(
    path.basename(spawn.installerPath),
    INSTALLER_ASSET_NAME,
    "the spawned file is the exact signed asset name",
  );
  // The installer executes from that path, so the pending file must survive
  // the handoff (deleting it is only for outcomes where nothing was spawned).
  assert.equal(fs.existsSync(spawn.installerPath), true);
  assert.deepEqual(stage.calls.unref, [spawn.installerPath]);
  assert.equal(stage.calls.quit, 1);
  assert.equal(stage.calls.dialogs.length, 0);
  assert.equal(stage.calls.downloadPage, 0);
  assert.deepEqual(reportCodes(stage), ["update-spawned"]);
  // Exactly once per launch: one discovery request for one stage call.
  assert.equal(
    fixture.calls.filter((call) => call.url === RELEASES_LATEST_URL).length,
    1,
  );
});

test("up-to-date launches the installed version silently", async (t) => {
  const fixture = buildScenario({ currentVersion: "2.0.0" });
  const stage = createStage(t, fixture);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "launch", reason: "up-to-date" });
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(stage.calls.quit, 0);
  assert.equal(stage.calls.dialogs.length, 0);
  assert.deepEqual(reportCodes(stage), ["update-check-completed"]);
  assert.deepEqual(stage.state().pendingDirectories, []);
  assert.equal(stage.state().lockExists, false);
});

test("a skipped check launches silently with its classified code", async (t) => {
  const fixture = buildScenario({
    responses: { [RELEASES_LATEST_URL]: () => errorResponse(503) },
  });
  const stage = createStage(t, fixture);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "launch", reason: "skipped" });
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(stage.calls.quit, 0);
  assert.equal(stage.calls.dialogs.length, 0);
  assert.deepEqual(reportCodes(stage), ["update-check-completed:http-error"]);
  assert.equal(stage.state().lockExists, false);
});

test("a failed verification shows bilingual guidance and launches", async (t) => {
  const fixture = buildScenario({
    signatureBase64: ({ canonicalText, keyPair }) => {
      const raw = Buffer.from(
        keyPair.signBytes(Buffer.from(canonicalText, "utf8")),
        "base64",
      );
      raw[0] ^= 0x01;
      return raw.toString("base64");
    },
  });
  const stage = createStage(t, fixture);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "launch", reason: "failed" });
  assert.deepEqual(reportCodes(stage), [
    "update-check-completed:invalid-signature",
  ]);
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(stage.calls.quit, 0);
  assertBilingual(stage.calls.dialogs[0]);
  // The default button in this fixture is "OK", so no external call is made.
  assert.equal(stage.calls.downloadPage, 0);
  assert.equal(stage.state().lockExists, false);
});

test("the guidance download button opens the release page", async (t) => {
  const fixture = buildScenario({
    keyring: { keys: [] },
    manifestOverrides: { keyId: "unknown-key" },
  });
  const stage = createStage(t, fixture);
  stage.setDialogResponse(0);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "launch", reason: "failed" });
  assert.equal(stage.calls.downloadPage, 1);
  assertBilingual(stage.calls.dialogs[0]);
});

test("an installer tampered after the download decision aborts before spawn", async (t) => {
  const fixture = buildScenario();
  const stage = createStage(t, fixture);

  // Watch the pending root while the installer download is still open, and
  // flip the first byte of the fully written file. The transport delays the
  // end of the body so the tamper is guaranteed to land after the last write
  // and before `runPreWindowStage` re-verifies the pending path.
  let tamperApplied = false;
  const baseTransport = fixture.transport;
  const delayedInstallerTransport = async (url, init) => {
    if (url !== INSTALLER_REDIRECT_URL) {
      return baseTransport(url, init);
    }
    const bytes = fixture.installerBytes;
    let phase = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(bytes);
          return;
        }
        await sleep(400);
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-length": String(bytes.length) },
    });
  };
  const watcher = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(stage.paths.pendingRoot)) {
        for (const entry of fs.readdirSync(stage.paths.pendingRoot)) {
          const candidate = path.join(
            stage.paths.pendingRoot,
            entry,
            INSTALLER_ASSET_NAME,
          );
          try {
            if (fs.statSync(candidate).size === fixture.installerBytes.length) {
              const handle = fs.openSync(candidate, "r+");
              fs.writeSync(handle, Buffer.from([0xff]), 0, 1, 0);
              fs.closeSync(handle);
              tamperApplied = true;
              return;
            }
          } catch {
            // The file is still being written; keep polling.
          }
        }
      }
      await sleep(10);
    }
  })();

  const decision = await stage.run({
    transport: delayedInstallerTransport,
  });
  await watcher;

  assert.equal(tamperApplied, true, "the watcher must have tampered the file");
  assert.deepEqual(decision, { action: "launch", reason: "failed" });
  assert.deepEqual(reportCodes(stage), [
    "update-check-completed:installer-hash-mismatch",
  ]);
  assert.equal(
    stage.calls.spawn.length,
    0,
    "a tampered installer never spawns",
  );
  assert.equal(stage.calls.quit, 0);
  assert.equal(stage.calls.dialogs.length, 1);
  assertBilingual(stage.calls.dialogs[0]);
  assert.deepEqual(
    stage.state().pendingDirectories,
    [],
    "the tampered pending directory is deleted",
  );
  assert.equal(stage.state().lockExists, false);
});

test("a spawn failure deletes the pending installer and falls back", async (t) => {
  const fixture = buildScenario();
  const stage = createStage(t, fixture);

  const decision = await stage.run({
    spawnInstaller: () => ({ ok: false, message: "simulated spawn failure" }),
  });

  assert.deepEqual(decision, { action: "launch", reason: "failed" });
  assert.deepEqual(reportCodes(stage), ["update-spawn-failed"]);
  assert.equal(stage.calls.quit, 0);
  assert.deepEqual(stage.state().pendingDirectories, []);
  assert.equal(stage.state().lockExists, false);
  assertBilingual(stage.calls.dialogs[0]);
  assert.match(
    stage.calls.dialogs[0].message,
    /installer could not be started|更新程式無法啟動/,
  );
});

test("lock contention skips without touching the network or the lock", async (t) => {
  const fixture = buildScenario({ now: () => FIXED_NOW });
  const stage = createStage(t, fixture);
  fs.mkdirSync(stage.paths.home, { recursive: true });
  const lockPath = plantLockFile(stage.updateBase, {
    acquiredAt: FIXED_NOW,
    pid: 777,
  });
  const lockBytes = fs.readFileSync(lockPath);

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "launch", reason: "skipped" });
  assert.deepEqual(reportCodes(stage), ["update-check-completed:lock-held"]);
  assert.equal(fixture.calls.length, 0, "no network request may be made");
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(stage.calls.quit, 0);
  assert.equal(stage.calls.dialogs.length, 0);
  assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
  assert.deepEqual(stage.state().pendingDirectories, []);
});

test("the overall budget bounds a hung check and classifies it as a skip", async (t) => {
  const fixture = buildScenario({
    limits: { requestTimeoutMs: 50, retries: 0 },
    transport: () => createAbortTransport(),
  });
  const stage = createStage(t, fixture);

  const decision = await stage.run({ overallTimeoutMs: 25 });

  assert.deepEqual(decision, { action: "launch", reason: "timeout" });
  assert.deepEqual(reportCodes(stage), ["update-check-timeout"]);
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(stage.calls.quit, 0);
  assert.equal(stage.calls.dialogs.length, 0);
  // The abandoned check still releases the lock on its own terminal path.
  assert.equal(
    await waitFor(() => stage.state().lockExists === false),
    true,
    "the per-user lock must be released after the timeout",
  );
});

test("a check that finishes after the deadline is never spawned and its pending directory is reclaimed", async (t) => {
  const fixture = buildScenario();
  const stage = createStage(t, fixture);
  const baseTransport = fixture.transport;
  const slowInstallerTransport = async (url, init) => {
    if (url !== INSTALLER_REDIRECT_URL) {
      return baseTransport(url, init);
    }
    const bytes = fixture.installerBytes;
    let phase = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(bytes);
          return;
        }
        await sleep(300);
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-length": String(bytes.length) },
    });
  };

  const decision = await stage.run({
    transport: slowInstallerTransport,
    overallTimeoutMs: 25,
  });

  assert.deepEqual(decision, { action: "launch", reason: "timeout" });
  assert.equal(stage.calls.spawn.length, 0);
  assert.equal(
    await waitFor(() => stage.state().pendingDirectories.length === 0),
    true,
    "a late update-ready must have its pending directory removed",
  );
  assert.equal(
    await waitFor(() => stage.state().lockExists === false),
    true,
    "the late check must still release the lock",
  );
});

test("an unrelated relaunch marker never influences the pre-window decision", async (t) => {
  // A stale marker from an earlier nonce must not affect a new decision: the
  // marker path is keyed by nonce, and the relaunch consumer owns it.
  const fixture = buildScenario();
  const stage = createStage(t, fixture);
  const statusDirectory = path.join(
    path.dirname(stage.profileDirectory),
    "update-status",
  );
  fs.mkdirSync(statusDirectory, { recursive: true });
  fs.writeFileSync(
    successMarkerPath(statusDirectory, "a".repeat(32)),
    JSON.stringify({ nonce: "a".repeat(32) }),
    "utf8",
  );

  const decision = await stage.run();

  assert.deepEqual(decision, { action: "quit", reason: "update-ready" });
  assert.equal(stage.calls.spawn.length, 1);
  // The unrelated marker is left alone; the relaunch consumer owns it.
  assert.equal(
    verifyAndConsumeSuccessMarker({
      statusDirectory,
      nonce: "a".repeat(32),
    }).ok,
    true,
  );
});

test("the spawn adapter classifies a non-existent installer as a failure", () => {
  const outcome = spawnDetachedInstaller(
    path.join(os.tmpdir(), "ytvw-does-not-exist-installer.exe"),
    ["/S"],
    INSTALLER_SPAWN_OPTIONS,
  );
  assert.equal(outcome.ok, false);
  assert.equal(typeof outcome.message, "string");
});

test("the stage module is Electron-free so it cannot create a window", async () => {
  const source = fs.readFileSync(
    new URL("../../src/main/update/startup.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+"electron"/);
  assert.doesNotMatch(source, /require\s*\(\s*["']electron["']\s*\)/);
  // And it is the only module that carries the NSIS handoff arguments.
  assert.match(source, /\/S/);
  assert.match(source, /--update-parent-pid=/);
  assert.match(source, /--update-nonce=/);
});
