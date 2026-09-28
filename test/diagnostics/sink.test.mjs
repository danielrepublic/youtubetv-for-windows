// Sink suite: opt-in sentinel, lazy directory creation, JSONL output,
// per-run unique file names, and the never-crash write contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  DIAGNOSTICS_ENABLE_MARKER_NAME,
  createDiagnosticsSink,
  createProfileDiagnostics,
  diagnosticsDirectory,
  diagnosticsEnableMarkerPath,
  isDiagnosticsRequested,
} = await import("../../src/main/diagnostics.ts");

function recordingFileSystem(calls, { fail = false } = {}) {
  return {
    existsSync: (candidate) => {
      calls.push(["existsSync", candidate]);
      return false;
    },
    mkdirSync: (candidate, options) => {
      calls.push(["mkdirSync", candidate, options?.recursive === true]);
      if (fail) {
        throw new Error("simulated mkdir failure");
      }
    },
    appendFileSync: (file, data, options) => {
      calls.push(["appendFileSync", file, data, options?.encoding]);
      if (fail) {
        throw new Error("simulated append failure");
      }
    },
  };
}

test("a disabled sink writes nothing and never touches the filesystem", () => {
  const calls = [];
  const sink = createDiagnosticsSink({
    enabled: false,
    baseDirectory: "C:\\base",
    fileSystem: recordingFileSystem(calls),
    now: () => new Date(0),
    instanceSuffix: "unit-off",
  });
  sink.record({ event: "app-ready" });
  sink.record({ event: "navigation-committed", origin: "https://x/?token=Z" });
  assert.deepEqual(calls, []);
  assert.deepEqual(sink.counters, { written: 0, failedWrites: 0, rejected: 0 });
  assert.equal(sink.enabled, false);
});

test("an enabled sink is lazy and appends redacted JSONL lines", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ytv-diag-sink-"));
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const sink = createDiagnosticsSink({
    enabled: true,
    baseDirectory: base,
    now: () => new Date(Date.UTC(2026, 8, 29, 10, 30, 0, 123)),
    instanceSuffix: "unit-on",
  });
  assert.equal(
    fs.existsSync(diagnosticsDirectory(base)),
    false,
    "construction must not create the directory",
  );
  sink.record({ event: "app-ready" });
  assert.equal(fs.existsSync(diagnosticsDirectory(base)), true);
  sink.record({
    event: "navigation-committed",
    origin: "https://www.youtube.com/tv?token=ZZSECRETZZ#frag",
  });
  sink.record({ event: "not-an-event" });
  assert.equal(sink.counters.written, 2);
  assert.equal(sink.counters.rejected, 1);
  assert.equal(sink.counters.failedWrites, 0);
  assert.match(
    path.basename(sink.filePath),
    /^diagnostic-20260929T103000123Z-unit-on\.jsonl$/,
  );
  const raw = fs.readFileSync(sink.filePath, "utf8");
  assert.ok(!raw.includes("ZZSECRETZZ"), `the file leaked a secret: ${raw}`);
  assert.ok(!raw.includes("?token="), "query strings must never be logged");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed).sort().length > 0, true);
    assert.equal(typeof parsed.ts, "number");
  }
  assert.equal(JSON.parse(lines[1]).origin, "https://www.youtube.com");
});

test("write failures are swallowed and counted, never thrown", () => {
  const calls = [];
  const sink = createDiagnosticsSink({
    enabled: true,
    baseDirectory: "C:\\base",
    fileSystem: recordingFileSystem(calls, { fail: true }),
    now: () => new Date(0),
    instanceSuffix: "unit-fail",
  });
  assert.doesNotThrow(() => sink.record({ event: "app-ready" }));
  assert.doesNotThrow(() => sink.record({ event: "app-ready" }));
  assert.equal(sink.counters.failedWrites, 2);
  assert.equal(sink.counters.written, 0);
  // Every failure is still attempted as a fresh write, so a transient lock or
  // full disk later in the run does not permanently disable the sink: the
  // directory-ensure step (which failed first) is retried on each record.
  assert.equal(calls.filter((call) => call[0] === "mkdirSync").length, 2);
});

test("the opt-in sentinel lives at the documented path and gates the factory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytv-diag-optin-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profileDirectory = path.join(root, "youtubetv-for-windows", "profile");
  const baseDirectory = path.dirname(profileDirectory);
  // OFF by default: no sentinel means no sink and no read of anything else.
  assert.equal(createProfileDiagnostics(profileDirectory), null);
  assert.equal(isDiagnosticsRequested(baseDirectory), false);
  assert.equal(
    diagnosticsEnableMarkerPath(baseDirectory),
    path.join(baseDirectory, "diagnostics", DIAGNOSTICS_ENABLE_MARKER_NAME),
  );
  fs.mkdirSync(diagnosticsDirectory(baseDirectory), { recursive: true });
  fs.writeFileSync(diagnosticsEnableMarkerPath(baseDirectory), "", "utf8");
  assert.equal(isDiagnosticsRequested(baseDirectory), true);
  const sink = createProfileDiagnostics(profileDirectory, {
    now: () => new Date(Date.UTC(2026, 8, 29, 10, 30, 0, 0)),
    instanceSuffix: "opt-in",
  });
  assert.ok(sink !== null, "the sentinel must enable the sink");
  assert.equal(
    sink.filePath,
    path.join(
      baseDirectory,
      "diagnostics",
      "diagnostic-20260929T103000000Z-opt-in.jsonl",
    ),
  );
  sink.record({ event: "app-ready" });
  assert.equal(sink.counters.written, 1);
  assert.equal(fs.existsSync(sink.filePath), true);
});

test("per-run file names are unique even for the same clock", () => {
  const options = {
    enabled: true,
    baseDirectory: "C:\\base",
    now: () => new Date(0),
  };
  const calls = [];
  const first = createDiagnosticsSink({
    ...options,
    fileSystem: recordingFileSystem(calls),
    instanceSuffix: "run-a",
  });
  const second = createDiagnosticsSink({
    ...options,
    fileSystem: recordingFileSystem(calls),
    instanceSuffix: "run-b",
  });
  assert.notEqual(first.filePath, second.filePath);
  // With no suffix injected the default pid+instance counter still differs.
  const third = createDiagnosticsSink({ ...options });
  const fourth = createDiagnosticsSink({ ...options });
  assert.notEqual(third.filePath, fourth.filePath);
});
