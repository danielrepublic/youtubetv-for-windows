// Spawned Electron suite for the child-popup policy.
//
// Two local HTTP servers stand in for two origins; the auth allowlist is
// injected with the auth server's origin for the happy path. Allowed
// children must share the opener's session (cookie visible across both),
// stay unprivileged, and inherit the secure webPreferences; every other
// destination is denied with or without external delegation.

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

function authResponder() {
  return {
    body: "<!doctype html><html><head><title>auth</title></head><body>auth</body></html>",
  };
}

function popupArgs(pageUrl, authOrigin, popupUrl, extra = []) {
  return [
    "--scenario=popup",
    `--page-url=${pageUrl}`,
    `--auth-origin=${authOrigin}`,
    `--popup-url=${popupUrl}`,
    ...extra,
  ];
}

test("an allowlisted popup shares the opener session and stays unprivileged", async (t) => {
  const main = await startFixtureServer(t);
  const auth = await startFixtureServer(t, authResponder);
  const authPage = `${auth.url}signin`;
  const run = await spawnFixtureHost(
    popupArgs(main.url, auth.url.slice(0, -1), authPage, [
      "--cookie-name=ytv_auth_probe",
      "--cookie-value=shared-secret",
    ]),
  );
  assertCleanRun(run);
  const result = recordOf(run.records, "popup-result");
  // Popups arrive as top-level windows (the opener's getChildWindows stays
  // empty while did-create-window fires), so popupCount is the assertion;
  // createdWindows proves the opener really emitted did-create-window.
  assert.equal(result.createdWindows, 1);
  assert.equal(result.popupCount, 1, "the allowlisted popup must be created");
  assert.equal(
    result.sessionSame,
    true,
    "the child must run in the opener session object",
  );
  assert.equal(result.childUrl, authPage);
  // The session cookie set on the opener is visible inside the child: the
  // persistent session really is shared, not merely same-origin.
  assert.match(result.cookie ?? "", /ytv_auth_probe=shared-secret/);
  // No Node capability leaks into the child renderer.
  assert.deepEqual(result.privilege, {
    requireType: "undefined",
    processType: "undefined",
  });
  assert.deepEqual(result.externalCalls, []);
});

test("a permitted external https popup delegates out and creates no child", async (t) => {
  const main = await startFixtureServer(t);
  const auth = await startFixtureServer(t, authResponder);
  const externalTarget = `https://127.0.0.1:${auth.port}/profile`;
  const run = await spawnFixtureHost(
    popupArgs(main.url, auth.url.slice(0, -1), externalTarget),
  );
  assertCleanRun(run);
  const result = recordOf(run.records, "popup-result");
  assert.equal(result.popupCount, 0, "no child for untrusted origins");
  assert.deepEqual(result.externalCalls, [externalTarget]);
});

test("dangerous popup schemes are denied with no child and no external call", async (t) => {
  const main = await startFixtureServer(t);
  const auth = await startFixtureServer(t, authResponder);
  const corpus = [
    "javascript:window.__popupProbe=1",
    "file:///C:/Windows/win.ini",
    "data:text/html,evil",
    "ytvwrapper://launch?target=evil",
  ];
  for (const candidate of corpus) {
    const run = await spawnFixtureHost(
      popupArgs(main.url, auth.url.slice(0, -1), candidate),
    );
    assertCleanRun(run);
    const result = recordOf(run.records, "popup-result");
    assert.equal(result.popupCount, 0, `no child may exist for ${candidate}`);
    assert.deepEqual(
      result.externalCalls,
      [],
      `no external call for ${candidate}`,
    );
  }
});

test("a child that leaves the allowlist is closed and delegated externally", async (t) => {
  const main = await startFixtureServer(t);
  const auth = await startFixtureServer(t, authResponder);
  const authPage = `${auth.url}signin`;
  const escapeTarget = "https://example.com/escaped";
  const run = await spawnFixtureHost(
    popupArgs(main.url, auth.url.slice(0, -1), authPage, [
      `--child-go=${escapeTarget}`,
    ]),
  );
  assertCleanRun(run);
  const opened = recordOf(run.records, "popup-result");
  assert.equal(opened.popupCount, 1, "the allowlisted child must open first");
  const redirect = recordOf(run.records, "child-redirect");
  assert.equal(redirect.destroyed, true, "the escaped child must be closed");
  assert.equal(redirect.remainingPopups, 0);
  assert.deepEqual(redirect.newExternal, [escapeTarget]);
});
