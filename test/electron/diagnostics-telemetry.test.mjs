// Spawned Electron suite for the opt-in diagnostics sink.
//
// The fixture host activates the real profile path under a fresh temp base
// and drives the real startHost composition against local fixture pages
// whose URLs carry secret-shaped query values; the fixture server also sets
// a cookie. When the documented sentinel file exists, a JSONL telemetry file
// must appear and every line must satisfy the redaction contract (allowlisted
// keys only, origins only, no secret material). When the sentinel is absent,
// no diagnostics file OR directory may be created.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

const ALLOWED_KEYS = ["ts", "event", "origin", "errorCode", "windowKind"];
const ALLOWED_EVENTS = [
  "app-ready",
  "app-quit",
  "window-created",
  "navigation-committed",
  "load-finished",
  "load-failed",
  "auth-window-opened",
  "auth-window-closed",
];
const ALLOWED_WINDOW_KINDS = ["main", "auth"];
// Substrings that must never appear in a telemetry file: the injected
// secret values first, then secret/URL shapes at large.
const FORBIDDEN_SUBSTRINGS = [
  "FIXTURE_QUERY_SECRET",
  "FIXTURE_POPUP_SECRET",
  "FIXTURE_FAIL_SECRET",
  "fixture-cookie-secret",
  "fixture-js-cookie-secret",
  "diag/index.html",
  "auth/signin",
  "token",
  "sapisid",
  "cookie",
  "sid=",
  "bearer",
  "authorization",
  "eyj",
  "?",
  "#",
];

let baseCounter = 0;

function freshBase(t) {
  baseCounter += 1;
  const base = path.join(
    os.tmpdir(),
    `ytv-diag-${process.pid}-${Date.now()}-${baseCounter}`,
  );
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function diagnosticsDirectoryFor(base) {
  return path.join(base, "youtubetv-for-windows", "diagnostics");
}

function enableDiagnostics(base) {
  fs.mkdirSync(diagnosticsDirectoryFor(base), { recursive: true });
  fs.writeFileSync(
    path.join(diagnosticsDirectoryFor(base), "ENABLED"),
    "",
    "utf8",
  );
}

function secretBearingResponder() {
  return {
    headers: {
      "set-cookie": "SID=fixture-cookie-secret; Path=/; Max-Age=86400",
    },
    body:
      "<!doctype html><html><head><title>diag</title></head><body>diag" +
      '<script>document.cookie = "SAPISID=fixture-js-cookie-secret; path=/";</script>' +
      "</body></html>",
  };
}

async function deadUrl(t) {
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
  return {
    origin: `http://127.0.0.1:${deadPort}`,
    url: `http://127.0.0.1:${deadPort}/tv?SAPISID=FIXTURE_FAIL_SECRET`,
  };
}

function diagnosticsArgs({ pageUrl, base, authOrigin, popupUrl, failUrl }) {
  return [
    "--scenario=diagnostics",
    `--page-url=${pageUrl}`,
    `--diagnostics-base=${base}`,
    `--auth-origin=${authOrigin}`,
    `--popup-url=${popupUrl}`,
    "--dialog-script=2",
    ...(failUrl === undefined ? [] : [`--fail-url=${failUrl}`]),
  ];
}

function parseTelemetryFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const records = lines.map((line) => JSON.parse(line));
  return { raw, lines, records };
}

function assertRedactionContract(records) {
  for (const record of records) {
    const keys = Object.keys(record);
    for (const key of keys) {
      assert.ok(
        ALLOWED_KEYS.includes(key),
        `telemetry emitted a non-allowlisted key "${key}"`,
      );
    }
    assert.ok(
      ALLOWED_EVENTS.includes(record.event),
      `telemetry emitted a non-allowlisted event "${record.event}"`,
    );
    assert.equal(typeof record.ts, "number");
    assert.equal(Number.isFinite(record.ts), true);
    if ("origin" in record) {
      assert.match(
        record.origin,
        /^https?:\/\/[^\s/?#]+$/,
        "an origin must be scheme+host+port with no path/query/fragment",
      );
    }
    if ("errorCode" in record) {
      assert.equal(Number.isInteger(record.errorCode), true);
    }
    if ("windowKind" in record) {
      assert.ok(ALLOWED_WINDOW_KINDS.includes(record.windowKind));
    }
  }
}

test("diagnostics ON records a redacted lifecycle trace and never leaks secrets", async (t) => {
  const fixture = await startFixtureServer(t, secretBearingResponder);
  const dead = await deadUrl(t);
  const base = freshBase(t);
  enableDiagnostics(base);
  const run = await spawnFixtureHost(
    diagnosticsArgs({
      pageUrl: `${fixture.url}diag/index.html?token=FIXTURE_QUERY_SECRET`,
      base,
      authOrigin: fixture.url.slice(0, -1),
      popupUrl: `${fixture.url}auth/signin?SAPISID=FIXTURE_POPUP_SECRET`,
      failUrl: dead.url,
    }),
  );
  assertCleanRun(run);
  const mode = recordOf(run.records, "diagnostics-mode");
  assert.equal(mode.enabled, true, "the sentinel must enable diagnostics");
  assert.equal(typeof mode.filePath, "string");
  assert.ok(
    mode.filePath.startsWith(diagnosticsDirectoryFor(base)),
    `unexpected telemetry path ${mode.filePath}`,
  );
  assert.match(path.basename(mode.filePath), /^diagnostic-.*\.jsonl$/);
  const done = recordOf(run.records, "diagnostics-done");
  assert.equal(done.filePath, mode.filePath);
  assert.equal(done.counters.failedWrites, 0);
  assert.equal(done.counters.rejected, 0);
  assert.ok(fs.existsSync(mode.filePath), "the telemetry file must exist");

  const { raw, lines, records } = parseTelemetryFile(mode.filePath);
  assert.ok(
    lines.length >= 8,
    `expected a real trace, got ${lines.length} lines`,
  );
  assert.equal(records.length, done.counters.written);
  assertRedactionContract(records);
  for (const forbidden of FORBIDDEN_SUBSTRINGS) {
    assert.ok(
      !raw.toLowerCase().includes(forbidden.toLowerCase()),
      `telemetry leaked "${forbidden}": ${raw}`,
    );
  }
  for (const expected of ALLOWED_EVENTS) {
    assert.ok(
      records.some((record) => record.event === expected),
      `missing "${expected}" in the trace: ${records
        .map((record) => record.event)
        .join(",")}`,
    );
  }
  const committed = records.find(
    (record) => record.event === "navigation-committed",
  );
  assert.equal(committed.origin, `http://127.0.0.1:${fixture.port}`);
  const finished = records.find((record) => record.event === "load-finished");
  assert.equal(finished.origin, `http://127.0.0.1:${fixture.port}`);
  const failed = records.find((record) => record.event === "load-failed");
  assert.equal(failed.origin, dead.origin);
  assert.ok(failed.errorCode < 0, "Chromium net errors are negative codes");
  assert.equal(recordOf(run.records, "diagnostics-popup").childOpened, true);
});

test("diagnostics OFF creates no telemetry file or directory", async (t) => {
  const fixture = await startFixtureServer(t, secretBearingResponder);
  const base = freshBase(t);
  const run = await spawnFixtureHost(
    diagnosticsArgs({
      pageUrl: `${fixture.url}diag/index.html?token=FIXTURE_QUERY_SECRET`,
      base,
      authOrigin: fixture.url.slice(0, -1),
      popupUrl: `${fixture.url}auth/signin?SAPISID=FIXTURE_POPUP_SECRET`,
    }),
  );
  assertCleanRun(run);
  const mode = recordOf(run.records, "diagnostics-mode");
  assert.equal(mode.enabled, false);
  assert.equal(mode.filePath, null);
  const done = recordOf(run.records, "diagnostics-done");
  assert.equal(done.filePath, null);
  assert.equal(done.counters, null);
  assert.equal(
    fs.existsSync(diagnosticsDirectoryFor(base)),
    false,
    "an OFF run must not create the diagnostics directory",
  );
  // The profile itself was still activated: the app ran normally.
  assert.ok(
    mode.profileDirectory.endsWith(
      path.join("youtubetv-for-windows", "profile"),
    ),
  );
});

test("each diagnostics run writes its own uniquely named file", async (t) => {
  const fixture = await startFixtureServer(t, secretBearingResponder);
  const base = freshBase(t);
  enableDiagnostics(base);
  const makeArgs = (label) =>
    diagnosticsArgs({
      pageUrl: `${fixture.url}diag/index.html?token=FIXTURE_QUERY_SECRET_${label}`,
      base,
      authOrigin: fixture.url.slice(0, -1),
      popupUrl: `${fixture.url}auth/signin?SAPISID=FIXTURE_POPUP_SECRET_${label}`,
    });
  const first = await spawnFixtureHost(makeArgs("one"));
  const second = await spawnFixtureHost(makeArgs("two"));
  assertCleanRun(first);
  assertCleanRun(second);
  const firstPath = recordOf(first.records, "diagnostics-mode").filePath;
  const secondPath = recordOf(second.records, "diagnostics-mode").filePath;
  assert.notEqual(firstPath, secondPath, "runs must never share a file");
  const files = fs
    .readdirSync(diagnosticsDirectoryFor(base))
    .filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 2, "no overwrite and no stray files");
  for (const file of files) {
    assert.match(file, /^diagnostic-\d{8}T\d{9}Z-p\d+-\d+\.jsonl$/);
  }
});
