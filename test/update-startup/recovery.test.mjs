// Terminal-outcome bookkeeping for one update attempt.
//
// The launcher quits before the installer can report anything, so a failed
// installer or a nonzero installer exit leaves no process that observed it.
// The suite pins the app-side signal that makes those outcomes classifiable
// anyway, and the reclaim that makes the pending installer copy stop
// accumulating:
//
//   - an attempt record is exactly `attempt-<nonce>.json` in the status
//     directory and carries the SIGNED manifest's target version,
//   - a relaunch carrying the nonce is resolved by that nonce's success marker,
//   - an ORDINARY launch with a record and no receipt is the failed-installer
//     case and classifies as a repair with no rollback promise,
//   - an attempt the running version already satisfies is consumed silently,
//     so a successful install whose receipt could not be written never nags,
//   - every terminal classification reclaims `pending/<nonce>`,
//   - the classification is one-shot: a consumed attempt never repeats,
//   - nothing outside a validated nonce is ever read from or removed,
//   - an ordinary launch with no record touches nothing, so a pending copy
//     belonging to a concurrent handoff is never deleted speculatively.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  UPDATE_ATTEMPT_RECORD_EXTENSION,
  UPDATE_ATTEMPT_RECORD_PREFIX,
  classifyUpdateRecovery,
  discardUpdateAttemptRecord,
  recordUpdateAttempt,
} = await import("../../src/main/update/recovery.ts");
const { createPendingDirectory, updateHomePaths } =
  await import("../../src/main/update/pending.ts");
const { successMarkerPath } = await import("../../src/main/update/relaunch.ts");
const { SUPPORT_RELEASE_URL, updateRepairDialog } =
  await import("../../src/main/dialogs.ts");

const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER_NONCE = "fedcba9876543210fedcba9876543210";
const TARGET_VERSION = "2.0.0";

/**
 * Real sibling directories under one temporary per-user base, so the status
 * directory, the pending root and the lock are laid out exactly as
 * `resolveUpdateDirectoryConvention` produces them in production.
 */
function createUpdateTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-recovery-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profileDirectory = path.join(root, "youtubetv-for-windows", "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const updateBase = path.join(root, "youtubetv-for-windows", "updates");
  const statusDirectory = path.join(
    root,
    "youtubetv-for-windows",
    "update-status",
  );
  const paths = updateHomePaths(updateBase);
  return {
    root,
    profileDirectory,
    statusDirectory,
    updateBase,
    pendingRoot: paths.pendingRoot,
    /** A pending directory holding a full installer copy, as a handoff leaves. */
    seedPending(nonce) {
      const created = createPendingDirectory(updateBase, nonce);
      assert.equal(created.ok, true);
      assert.equal(created.directory, path.join(paths.pendingRoot, nonce));
      fs.writeFileSync(
        path.join(created.directory, "youtubetv-for-windows-x64.exe"),
        Buffer.alloc(4096, 0x41),
      );
      return created.directory;
    },
    pendingNonces() {
      return fs.existsSync(paths.pendingRoot)
        ? fs.readdirSync(paths.pendingRoot)
        : [];
    },
    statusEntries() {
      return fs.existsSync(statusDirectory)
        ? fs.readdirSync(statusDirectory)
        : [];
    },
    recordPath(nonce) {
      return path.join(
        statusDirectory,
        `${UPDATE_ATTEMPT_RECORD_PREFIX}${nonce}${UPDATE_ATTEMPT_RECORD_EXTENSION}`,
      );
    },
  };
}

function publishSuccessMarker(statusDirectory, nonce) {
  fs.mkdirSync(statusDirectory, { recursive: true });
  fs.writeFileSync(
    successMarkerPath(statusDirectory, nonce),
    JSON.stringify({ nonce }),
    "utf8",
  );
}

function assertBilingualRepair(classification) {
  const dialog = updateRepairDialog(classification.reason);
  assert.match(dialog.title, /[\u4e00-\u9fff]/, "missing Traditional Chinese");
  assert.match(dialog.title, /[A-Za-z]{4,}/, "missing English");
  assert.match(
    dialog.message,
    /[\u4e00-\u9fff]/,
    "missing Traditional Chinese",
  );
  assert.match(dialog.message, /[A-Za-z]{4,}/, "missing English");
  assert.equal(dialog.detail, SUPPORT_RELEASE_URL);
  assert.deepEqual(dialog.buttons.length, 2);
  // The message may never promise a restore it cannot perform.
  assert.doesNotMatch(
    dialog.message,
    /rolled back|restored|reverted|已回復|已還原/,
    "a repair message must never promise recovery the design cannot provide",
  );
}

test("an attempt record is exactly attempt-<nonce>.json with the signed target version", (t) => {
  const tree = createUpdateTree(t);

  const result = recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(tree.statusEntries(), [
    `${UPDATE_ATTEMPT_RECORD_PREFIX}${NONCE}${UPDATE_ATTEMPT_RECORD_EXTENSION}`,
  ]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(tree.recordPath(NONCE), "utf8")),
    { nonce: NONCE, version: TARGET_VERSION },
  );
});

test("a replayed nonce is refused instead of overwriting a recorded attempt", (t) => {
  const tree = createUpdateTree(t);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: "2.0.0",
  });

  const replay = recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: "3.0.0",
  });

  assert.equal(replay.ok, false);
  assert.equal(
    JSON.parse(fs.readFileSync(tree.recordPath(NONCE), "utf8")).version,
    "2.0.0",
    "the first attempt's record must survive a replayed write",
  );
});

test("a nonce that is not 32 lowercase hex is refused and touches no path", (t) => {
  const tree = createUpdateTree(t);

  for (const nonce of [
    "..",
    "../escape",
    "ABCDEF0123456789ABCDEF0123456789",
    "0".repeat(31),
    "0".repeat(33),
  ]) {
    const result = recordUpdateAttempt({
      statusDirectory: tree.statusDirectory,
      nonce,
      version: TARGET_VERSION,
    });
    assert.equal(result.ok, false, `must refuse ${JSON.stringify(nonce)}`);
  }

  assert.deepEqual(tree.statusEntries(), []);
  assert.equal(
    fs.existsSync(path.join(tree.root, "escape.json")),
    false,
    "no rejected nonce may create a file outside the status directory",
  );
});

test("a nonce launch with a valid marker confirms the install and reclaims the copy", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });
  publishSuccessMarker(tree.statusDirectory, NONCE);

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: NONCE,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "confirmed", nonce: NONCE });
  assert.deepEqual(tree.pendingNonces(), [], "the installer copy is reclaimed");
  assert.deepEqual(
    tree.statusEntries(),
    [],
    "both the one-shot receipt and the attempt record are consumed",
  );
});

test("a nonce launch without a receipt repairs, and still reclaims the copy", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: NONCE,
    currentVersion: TARGET_VERSION,
  });

  assert.equal(classification.kind, "repair");
  assert.equal(classification.reason, "missing");
  assertBilingualRepair(classification);
  assert.deepEqual(classification.nonces, [NONCE]);
  assert.deepEqual(tree.pendingNonces(), []);
  assert.deepEqual(tree.statusEntries(), []);
});

test("a dead installer on an ordinary launch classifies as a repair (failed installer / nonzero exit)", (t) => {
  // The installer aborted in .onInit or died mid-install, so it published no
  // receipt and never relaunched the app. The running version is still the old
  // one, so nothing can be confirmed and the user must be told.
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.equal(classification.kind, "repair");
  assert.equal(classification.reason, "unconfirmed");
  assert.deepEqual(classification.nonces, [NONCE]);
  assertBilingualRepair(classification);
  assert.deepEqual(
    tree.pendingNonces(),
    [],
    "a dead installer leaves a copy nothing will ever run again",
  );
  assert.deepEqual(tree.statusEntries(), [], "the record is consumed");
});

test("an attempt the running version already satisfies is consumed without a repair", (t) => {
  // The install landed but its receipt could not be published, so the include
  // relaunched the app WITHOUT the nonce. Nothing is broken, so nothing is
  // claimed: the record is consumed and the copy reclaimed, silently.
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: TARGET_VERSION,
  });

  assert.equal(classification.kind, "satisfied");
  assert.deepEqual(tree.pendingNonces(), []);
  assert.deepEqual(tree.statusEntries(), []);
});

test("a newer installed version than the recorded target is also satisfied", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "3.1.0",
  });

  assert.equal(classification.kind, "satisfied");
  assert.deepEqual(tree.pendingNonces(), []);
});

test("an unparsable version fails closed to a repair, never to silence", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  fs.mkdirSync(tree.statusDirectory, { recursive: true });
  fs.writeFileSync(
    tree.recordPath(NONCE),
    JSON.stringify({ nonce: NONCE, version: "not-a-version" }),
    "utf8",
  );

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "also-not-a-version",
  });

  assert.equal(classification.kind, "repair");
  assert.equal(classification.reason, "unconfirmed");
});

test("a receipt published without a relaunch confirms and is consumed", (t) => {
  // The installer published the marker and then died before relaunching. The
  // install did complete, so this must not be reported as a repair.
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });
  publishSuccessMarker(tree.statusDirectory, NONCE);

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "confirmed", nonce: NONCE });
  assert.deepEqual(tree.pendingNonces(), []);
  assert.deepEqual(tree.statusEntries(), [], "the stale receipt is consumed");
});

test("several recorded attempts are classified together and reported once", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  tree.seedPending(OTHER_NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: OTHER_NONCE,
    version: "9.0.0",
  });
  publishSuccessMarker(tree.statusDirectory, NONCE);

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.equal(classification.kind, "repair");
  assert.deepEqual([...classification.nonces].sort(), [OTHER_NONCE].sort());
  assertBilingualRepair(classification);
  assert.deepEqual(
    tree.pendingNonces(),
    [],
    "every terminal attempt reclaims its own copy",
  );
  assert.deepEqual(tree.statusEntries(), []);
});

test("a repair is one-shot: a second launch reports nothing again", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });
  const first = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });
  assert.equal(first.kind, "repair");

  const second = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(second, { kind: "none" });
});

test("a hostile or malformed record name is ignored and deletes nothing", (t) => {
  const tree = createUpdateTree(t);
  const unowned = tree.seedPending(OTHER_NONCE);
  fs.mkdirSync(tree.statusDirectory, { recursive: true });
  for (const name of [
    `attempt-${"0".repeat(31)}.json`,
    `attempt-${"A".repeat(32)}.json`,
    "attempt-..json",
    "attempt.json",
    "attempt-0123456789abcdef0123456789abcdeff.json",
    "success-0123456789abcdef0123456789abcdef.json",
  ]) {
    fs.writeFileSync(path.join(tree.statusDirectory, name), "{}", {
      encoding: "utf8",
    });
  }
  // A path-traversal name that the real update domain's nonce could never
  // produce: it must not become a filesystem target.
  const outsideTarget = path.join(tree.statusDirectory, "..", "escape.json");
  fs.writeFileSync(outsideTarget, "{}", { encoding: "utf8" });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "none" });
  assert.deepEqual(
    tree.pendingNonces(),
    [OTHER_NONCE],
    "an unrecognised record must never delete a pending copy it does not name",
  );
  assert.equal(fs.existsSync(unowned), true);
});

test("a record whose payload disagrees with its file name is unconfirmable", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  fs.mkdirSync(tree.statusDirectory, { recursive: true });
  fs.writeFileSync(
    tree.recordPath(NONCE),
    JSON.stringify({ nonce: OTHER_NONCE, version: TARGET_VERSION }),
    "utf8",
  );

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.equal(classification.kind, "repair");
  assert.equal(classification.reason, "unconfirmed");
  assert.deepEqual(classification.nonces, [NONCE]);
  assert.deepEqual(tree.pendingNonces(), []);
});

test("an unreadable record is unconfirmable rather than silently trusted", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(NONCE);
  fs.mkdirSync(tree.statusDirectory, { recursive: true });
  fs.writeFileSync(tree.recordPath(NONCE), "", { encoding: "utf8" });

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.equal(classification.kind, "repair");
  assert.deepEqual(tree.pendingNonces(), []);
});

test("an ordinary launch with no record touches nothing", (t) => {
  const tree = createUpdateTree(t);
  const unowned = tree.seedPending(NONCE);

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "none" });
  assert.equal(
    fs.existsSync(unowned),
    true,
    "a pending copy with no record may belong to a concurrent handoff",
  );
});

test("a missing status directory is an ordinary no-attempt launch", (t) => {
  const tree = createUpdateTree(t);

  const classification = classifyUpdateRecovery({
    statusDirectory: path.join(tree.root, "never-created"),
    updateBaseDirectory: tree.updateBase,
    launchNonce: null,
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "none" });
});

test("a hostile launch nonce is never joined into a path", (t) => {
  const tree = createUpdateTree(t);
  tree.seedPending(OTHER_NONCE);

  const classification = classifyUpdateRecovery({
    statusDirectory: tree.statusDirectory,
    updateBaseDirectory: tree.updateBase,
    launchNonce: "../../escape",
    currentVersion: "1.0.0",
  });

  assert.deepEqual(classification, { kind: "none" });
  assert.deepEqual(
    tree.pendingNonces(),
    [OTHER_NONCE],
    "a rejected launch nonce must not remove anything",
  );
  assert.equal(
    fs.existsSync(path.join(tree.updateBase, "..", "escape")),
    false,
  );
});

test("discarding an attempt removes only its own record", (t) => {
  const tree = createUpdateTree(t);
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: NONCE,
    version: TARGET_VERSION,
  });
  recordUpdateAttempt({
    statusDirectory: tree.statusDirectory,
    nonce: OTHER_NONCE,
    version: TARGET_VERSION,
  });

  assert.equal(discardUpdateAttemptRecord(tree.statusDirectory, NONCE), true);
  assert.equal(
    discardUpdateAttemptRecord(tree.statusDirectory, NONCE),
    false,
    "a consumed record cannot be consumed twice",
  );
  assert.equal(
    discardUpdateAttemptRecord(tree.statusDirectory, "../escape"),
    false,
    "a hostile nonce is refused before any path is built",
  );
  assert.deepEqual(tree.statusEntries(), [
    `${UPDATE_ATTEMPT_RECORD_PREFIX}${OTHER_NONCE}${UPDATE_ATTEMPT_RECORD_EXTENSION}`,
  ]);
});
