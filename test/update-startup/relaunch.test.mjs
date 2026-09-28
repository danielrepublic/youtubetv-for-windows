// Post-install success-marker verification contract.
//
// After NSIS installs the update it writes `success-<nonce>.json`
// atomically and relaunches the app with `--update-nonce=<nonce>`. The
// relaunched bootstrap must:
//   - accept ONLY a marker whose `nonce` field equals the launch nonce,
//   - consume (delete) the marker exactly once so a later launch cannot see
//     a stale success,
//   - classify a missing or invalid marker without throwing, and delete an
//     invalid marker so the same warning cannot repeat forever,
//   - never construct a path from an unvalidated nonce.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  UPDATE_SUCCESS_MARKER_EXTENSION,
  UPDATE_SUCCESS_MARKER_PREFIX,
  successMarkerPath,
  verifyAndConsumeSuccessMarker,
} = await import("../../src/main/update/relaunch.ts");

const NONCE = "0123456789abcdef0123456789abcdef";

function createStatusDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-status-"));
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("the marker name is exactly success-<nonce>.json", () => {
  assert.equal(UPDATE_SUCCESS_MARKER_PREFIX, "success-");
  assert.equal(UPDATE_SUCCESS_MARKER_EXTENSION, ".json");
  assert.equal(
    successMarkerPath("C:\\status", NONCE),
    path.join("C:\\status", `success-${NONCE}.json`),
  );
});

test("a valid marker verifies and is consumed exactly once", (t) => {
  const statusDirectory = createStatusDirectory(t);
  const markerPath = successMarkerPath(statusDirectory, NONCE);
  fs.writeFileSync(markerPath, JSON.stringify({ nonce: NONCE }), "utf8");

  const first = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: NONCE,
  });
  assert.deepEqual(first, { ok: true });
  assert.equal(
    fs.existsSync(markerPath),
    false,
    "the marker must be consumed (deleted) on success",
  );

  // A second launch must not see a stale success.
  const second = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: NONCE,
  });
  assert.deepEqual(second, { ok: false, reason: "missing" });
});

test("a missing marker is classified, not thrown", (t) => {
  const statusDirectory = createStatusDirectory(t);
  const result = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: NONCE,
  });
  assert.deepEqual(result, { ok: false, reason: "missing" });
});

test("a marker for a different nonce is invalid and is deleted", (t) => {
  const statusDirectory = createStatusDirectory(t);
  const markerPath = successMarkerPath(statusDirectory, NONCE);
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ nonce: "other-nonce" }),
    "utf8",
  );

  const result = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: NONCE,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid" });
  assert.equal(
    fs.existsSync(markerPath),
    false,
    "an invalid marker can never become valid; it must not repeat forever",
  );
});

test("malformed and wrong-shaped markers are invalid", (t) => {
  const statusDirectory = createStatusDirectory(t);
  const markerPath = successMarkerPath(statusDirectory, NONCE);

  for (const contents of [
    "not json at all",
    "[]",
    '"nonce"',
    "null",
    JSON.stringify({ nonce: 42 }),
    JSON.stringify({ other: NONCE }),
    JSON.stringify({ nonce: `${NONCE} ` }),
  ]) {
    fs.writeFileSync(markerPath, contents, "utf8");
    const result = verifyAndConsumeSuccessMarker({
      statusDirectory,
      nonce: NONCE,
    });
    assert.deepEqual(
      result,
      { ok: false, reason: "invalid" },
      `must reject marker contents ${contents}`,
    );
    assert.equal(fs.existsSync(markerPath), false);
  }
});

test("an unreadable marker path is invalid, not thrown", (t) => {
  const statusDirectory = createStatusDirectory(t);
  // A directory at the marker path: readFileSync fails with a
  // non-ENOENT error, which must not escape as an exception.
  fs.mkdirSync(successMarkerPath(statusDirectory, NONCE));
  const result = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: NONCE,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid" });
});

test("a nonce that could escape the status directory never reaches the filesystem", (t) => {
  const statusDirectory = createStatusDirectory(t);
  const outside = path.join(statusDirectory, "..", "escape.json");
  const result = verifyAndConsumeSuccessMarker({
    statusDirectory,
    nonce: "../escape",
  });
  assert.deepEqual(result, { ok: false, reason: "invalid" });
  assert.equal(fs.existsSync(outside), false);
});
