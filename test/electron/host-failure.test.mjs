// Spawned Electron suite for the bilingual host-failure policy.
//
// The compiled production navigation policy is installed on a real window,
// then the TV route is lost two ways: a finished load off the TV route
// (redirected-away) and an unreachable target (load-failed). The scripted
// dialog presenter records the exact native-dialog options — asserted here
// for the three bilingual actions — and returns scripted clicks so the
// bounded recovery loop is exercised end to end.

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

const SUPPORT_RELEASE_URL =
  "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest";

function assertThreeBilingualActions(dialogOptions) {
  assert.ok(dialogOptions.length > 0, "the failure dialog must be shown");
  for (const options of dialogOptions) {
    assert.deepEqual(options.buttons, [
      "重試 (Retry)",
      "在瀏覽器中開啟 (Open in browser)",
      "支援 (Support)",
    ]);
    assert.match(options.message, /無法|失敗|重新導向/);
    assert.match(options.message, /retry|failed to load|redirected/i);
  }
}

test("redirected-away offers retry, browser, and support, then opens the browser", async (t) => {
  const fixture = await startFixtureServer(t);
  const offRoute = `${fixture.url}plain`;
  // Script [1]: click "在瀏覽器中開啟 (Open in browser)". The failed URL is
  // a local http: address, so the policy opens the validated TV target —
  // here the local page, which keeps the test hermetic.
  const run = await spawnFixtureHost([
    "--scenario=route",
    `--page-url=${offRoute}`,
    `--target-url=${offRoute}`,
    "--dialog-script=1",
  ]);
  assertCleanRun(run);
  const result = recordOf(run.records, "route-result");
  assertThreeBilingualActions(result.dialogOptions);
  assert.equal(result.dialogOptions.length, 1);
  assert.deepEqual(result.externalCalls, [offRoute]);
  assert.ok(
    result.navigationEvents.includes("did-finish-load"),
    `expected a finished load, saw ${result.navigationEvents}`,
  );
});

test("retries are bounded: exhaustion stops the loop without looping forever", async (t) => {
  const fixture = await startFixtureServer(t);
  const offRoute = `${fixture.url}plain`;
  // Script [0,0,0]: always retry against the local off-route target. One
  // initial dialog plus exactly two reloads (MAX_ROUTE_RETRIES), then
  // retries-exhausted with no fourth dialog and no external call.
  const run = await spawnFixtureHost([
    "--scenario=route",
    `--page-url=${offRoute}`,
    `--target-url=${offRoute}`,
    "--dialog-script=0,0,0",
  ]);
  assertCleanRun(run);
  const result = recordOf(run.records, "route-result");
  assertThreeBilingualActions(result.dialogOptions);
  assert.equal(result.dialogOptions.length, 3);
  assert.deepEqual(result.externalCalls, []);
  const finishedLoads = result.navigationEvents.filter(
    (entry) => entry === "did-finish-load",
  );
  assert.equal(finishedLoads.length, 3);
});

test("support opens the release page via the external opener", async (t) => {
  const fixture = await startFixtureServer(t);
  const offRoute = `${fixture.url}plain`;
  const run = await spawnFixtureHost([
    "--scenario=route",
    `--page-url=${offRoute}`,
    `--target-url=${offRoute}`,
    "--dialog-script=2",
  ]);
  assertCleanRun(run);
  const result = recordOf(run.records, "route-result");
  assertThreeBilingualActions(result.dialogOptions);
  assert.deepEqual(result.externalCalls, [SUPPORT_RELEASE_URL]);
});

test("load failure shows the same bilingual dialog and reaches support", async (t) => {
  // Bind a port, then close it, so the target is deterministically
  // unreachable (connection refused) without touching the network.
  const holder = await startFixtureServer(t);
  const deadPort = holder.port;
  await new Promise((resolve, reject) => {
    holder.server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve(undefined);
      }
    });
  });
  const deadUrl = `http://127.0.0.1:${deadPort}/tv`;
  const run = await spawnFixtureHost([
    "--scenario=loadfail",
    `--page-url=${deadUrl}`,
    `--target-url=${deadUrl}`,
    "--dialog-script=2",
  ]);
  assertCleanRun(run);
  const result = recordOf(run.records, "loadfail-result");
  assertThreeBilingualActions(result.dialogOptions);
  assert.deepEqual(result.externalCalls, [SUPPORT_RELEASE_URL]);
  assert.ok(
    result.navigationEvents.some(
      (entry) => entry.startsWith("did-fail-load:") && entry.includes(":true:"),
    ),
    `expected a main-frame did-fail-load, saw ${result.navigationEvents}`,
  );
});
