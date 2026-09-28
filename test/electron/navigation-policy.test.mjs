// Spawned Electron suite for the main-window navigation policy.
//
// A local fixture page is loaded, the compiled production navigation policy
// is installed, and unexpected navigations are driven through
// renderer-initiated location.href (the will-navigate path). Every spawn is
// timeout-bounded with a process-tree kill.

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

function navArgs(pageUrl, goUrls) {
  return [
    "--scenario=nav",
    `--page-url=${pageUrl}`,
    ...goUrls.map((go) => `--go=${go}`),
  ];
}

test("unexpected https navigation is cancelled and delegated externally", async (t) => {
  const fixture = await startFixtureServer(t);
  const externalTarget = `https://127.0.0.1:${fixture.port}/unexpected`;
  const run = await spawnFixtureHost(navArgs(fixture.url, [externalTarget]));
  assertCleanRun(run);
  const results = recordOf(run.records, "nav-results");
  assert.equal(results.results.length, 1);
  const attempt = results.results[0];
  // The main window must not navigate away: the URL is unchanged.
  assert.equal(attempt.urlAfter, attempt.urlBefore);
  assert.equal(attempt.urlAfter, fixture.url);
  // The valid https: target delegates to the injected opener, exactly once.
  assert.deepEqual(attempt.newExternal, [externalTarget]);
  assert.deepEqual(results.externalCalls, [externalTarget]);
  assert.ok(results.dialogOptions.length === 0, "no dialog for delegation");
  // Mechanism proof: Electron really fired will-navigate for the attempt.
  assert.ok(
    results.navigationEvents.some((entry) =>
      entry.startsWith(`will-navigate:${externalTarget}`),
    ),
    `expected a will-navigate tap, saw ${results.navigationEvents}`,
  );
});

test("scheme abuse is denied silently with no navigation and no external call", async (t) => {
  const fixture = await startFixtureServer(t);
  const corpus = [
    "javascript:window.__navProbe=1",
    "file:///C:/Windows/win.ini",
    "data:text/html,evil",
    "ytvwrapper://launch?target=evil",
    `http://127.0.0.1:${fixture.port}/plain-http`,
  ];
  const run = await spawnFixtureHost(navArgs(fixture.url, corpus));
  assertCleanRun(run);
  const results = recordOf(run.records, "nav-results");
  assert.equal(results.results.length, corpus.length);
  for (let index = 0; index < corpus.length; index += 1) {
    const attempt = results.results[index];
    assert.equal(
      attempt.urlAfter,
      fixture.url,
      `navigation must not occur for ${corpus[index]}`,
    );
    assert.deepEqual(
      attempt.newExternal,
      [],
      `no external call for ${corpus[index]}`,
    );
  }
  assert.deepEqual(results.externalCalls, []);
  assert.ok(results.dialogOptions.length === 0, "denials show nothing");
});
