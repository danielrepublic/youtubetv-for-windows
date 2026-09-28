// Pure redaction suite for the diagnostics sanitizer.
//
// The contract under test: NO string an attacker (or a bug) can place in any
// diagnostics field may survive into an emitted JSON line. Every field of the
// allowlisted schema is injected with token/cookie/query-secret-shaped values
// and the emitted line is asserted to contain neither the secret material nor
// a single key outside { ts, event, origin, errorCode, windowKind }.

import assert from "node:assert/strict";
import test from "node:test";

const {
  ALLOWED_DIAGNOSTIC_FIELDS,
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_WINDOW_KINDS,
  formatDiagnosticLine,
  looksLikeSecret,
  sanitizeDiagnosticRecord,
  sanitizeOrigin,
} = await import("../../src/main/diagnostics.ts");

// Every value contains the marker ZZSECRETZZ plus a distinct secret shape, so
// one substring assertion proves no field leaked any of them.
const SECRET_CORPUS = [
  "https://x/?token=ZZSECRETZZ",
  "SAPISID=ZZSECRETZZ",
  "eyJhbGciOiJIUzI1NiJ9.ZZSECRETZZ.c2lnbmF0dXJl",
  "Bearer ZZSECRETZZ",
  "authorization: Bearer ZZSECRETZZ",
  "cookie: SID=ZZSECRETZZ",
];

const TRUSTED_NOW = 1760000000000;

function baseInput() {
  return {
    event: "load-failed",
    origin: "https://www.youtube.com",
    errorCode: -102,
    windowKind: "main",
    ts: 1,
  };
}

test("secret-shaped values never reach an emitted line in any field", () => {
  let emitted = 0;
  for (const secret of SECRET_CORPUS) {
    for (const field of ALLOWED_DIAGNOSTIC_FIELDS) {
      const input = baseInput();
      input[field] = secret;
      const line = formatDiagnosticLine(input, TRUSTED_NOW);
      if (line === null) {
        // A secret placed in `event` can never match the allowlist, so the
        // whole record is rejected rather than emitted.
        assert.equal(field, "event");
        continue;
      }
      emitted += 1;
      assert.ok(
        !line.includes("ZZSECRETZZ"),
        `field ${field} leaked the secret: ${line}`,
      );
      assert.ok(
        !/token=|sapisid|bearer|authorization|cookie/i.test(line),
        `field ${field} leaked a secret shape: ${line}`,
      );
      assert.ok(!line.includes("eyJ"), `field ${field} leaked a JWT: ${line}`);
      const parsed = JSON.parse(line);
      const keys = Object.keys(parsed);
      const unknown = keys.filter(
        (key) => !ALLOWED_DIAGNOSTIC_FIELDS.includes(key),
      );
      assert.deepEqual(unknown, [], `unknown keys emitted: ${keys.join(",")}`);
      assert.ok(DIAGNOSTIC_EVENTS.includes(parsed.event));
      // `ts` is never taken from the caller, so injecting it cannot smuggle
      // anything into the line and cannot displace the trusted clock.
      assert.equal(parsed.ts, TRUSTED_NOW);
      if ("origin" in parsed) {
        assert.match(parsed.origin, /^https?:\/\/[^\s/?#]+$/);
      }
      if ("errorCode" in parsed) {
        assert.equal(Number.isInteger(parsed.errorCode), true);
      }
      if ("windowKind" in parsed) {
        assert.ok(DIAGNOSTIC_WINDOW_KINDS.includes(parsed.windowKind));
      }
    }
  }
  assert.ok(
    emitted >= SECRET_CORPUS.length * (ALLOWED_DIAGNOSTIC_FIELDS.length - 1),
    `expected most injections to emit a redacted line, emitted ${emitted}`,
  );
});

test("unknown keys are dropped and only the allowlisted schema is emitted", () => {
  const line = formatDiagnosticLine(
    {
      event: "load-failed",
      evil: "x",
      token: "ZZSECRETZZ",
      cookieHeader: "SID=ZZSECRETZZ",
      origin: "https://www.youtube.com",
    },
    TRUSTED_NOW,
  );
  assert.ok(line !== null);
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), [
    "event",
    "origin",
    "ts",
  ]);
  assert.ok(!line.includes("ZZSECRETZZ"));
});

test("unknown events are rejected outright, never rewritten", () => {
  assert.equal(formatDiagnosticLine({ event: "evil-event" }, 5), null);
  assert.equal(formatDiagnosticLine({ event: "" }, 5), null);
  assert.equal(formatDiagnosticLine({ event: "preload-loaded" }, 5), null);
  assert.equal(formatDiagnosticLine({ event: 42 }, 5), null);
  assert.equal(formatDiagnosticLine(null, 5), null);
  assert.equal(formatDiagnosticLine([], 5), null);
  assert.equal(formatDiagnosticLine("load-failed", 5), null);
});

test("origins are reduced to scheme+host+port only", () => {
  assert.equal(
    sanitizeOrigin("https://user:pass@www.youtube.com/tv?token=abc&x=1#frag"),
    "https://www.youtube.com",
  );
  assert.equal(
    sanitizeOrigin("http://127.0.0.1:9999/diag?SAPISID=abc#top"),
    "http://127.0.0.1:9999",
  );
  assert.equal(
    sanitizeOrigin("https://accounts.google.com/o/oauth2/v2/auth"),
    "https://accounts.google.com",
  );
  assert.equal(sanitizeOrigin("javascript:alert(1)"), undefined);
  assert.equal(sanitizeOrigin("data:text/html,evil"), undefined);
  assert.equal(sanitizeOrigin("file:///C:/Windows/win.ini"), undefined);
  assert.equal(sanitizeOrigin("not a url"), undefined);
  assert.equal(sanitizeOrigin(""), undefined);
  assert.equal(sanitizeOrigin(42), undefined);
  assert.equal(sanitizeOrigin(null), undefined);
  assert.equal(sanitizeOrigin(undefined), undefined);
});

test("numeric and enum fields are validated, ts always comes from the clock", () => {
  const parsed = (input) => JSON.parse(formatDiagnosticLine(input, 123));
  assert.deepEqual(parsed({ event: "load-failed", errorCode: -102 }), {
    ts: 123,
    event: "load-failed",
    errorCode: -102,
  });
  assert.equal(
    "errorCode" in parsed({ event: "load-failed", errorCode: "-102" }),
    false,
  );
  assert.equal(
    "errorCode" in parsed({ event: "load-failed", errorCode: 1.5 }),
    false,
  );
  assert.equal(
    "errorCode" in parsed({ event: "load-failed", errorCode: Number.NaN }),
    false,
  );
  assert.equal(
    "errorCode" in parsed({ event: "load-failed", errorCode: 2 ** 40 }),
    false,
  );
  assert.equal(parsed({ event: "load-failed", ts: 9 }).ts, 123);
  assert.equal(
    parsed({ event: "window-created", windowKind: "auth" }).windowKind,
    "auth",
  );
  assert.equal(
    parsed({ event: "window-created", windowKind: "main" }).windowKind,
    "main",
  );
  assert.equal(
    "windowKind" in parsed({ event: "window-created", windowKind: "evil" }),
    false,
  );
  assert.equal(
    sanitizeDiagnosticRecord({ event: "app-ready" }, Number.NaN),
    null,
  );
});

test("the secret-shape detector fails closed on token-like material", () => {
  for (const value of [
    ...SECRET_CORPUS,
    "a".repeat(64),
    "0123456789abcdef0123456789abcdef",
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY=",
  ]) {
    assert.equal(looksLikeSecret(value), true, `must flag ${value}`);
  }
  for (const value of [
    "https://www.youtube.com",
    "http://127.0.0.1:8080",
    "https://accounts.google.com",
    "main",
    "load-failed",
    "navigation-committed",
  ]) {
    assert.equal(looksLikeSecret(value), false, `must not flag ${value}`);
  }
});
