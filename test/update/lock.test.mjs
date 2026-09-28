import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acquireUpdateLock } from "../../src/main/update/lock.ts";
import { updateHomePaths } from "../../src/main/update/pending.ts";
import {
  FIXED_NOW,
  createTempBaseDirectory,
  plantLockFile,
} from "./fixture-helpers.mjs";

const STALE_MS = 60_000;

test("acquires the lock atomically and releases it idempotently", () => {
  const temp = createTempBaseDirectory();
  try {
    const lock = acquireUpdateLock({
      baseDirectory: temp.baseDirectory,
      now: () => FIXED_NOW,
      staleMs: STALE_MS,
    });
    assert.equal(lock.ok, true);
    const paths = updateHomePaths(temp.baseDirectory);
    assert.equal(fs.existsSync(paths.lockPath), true);
    const payload = JSON.parse(fs.readFileSync(paths.lockPath, "utf8"));
    assert.equal(payload.acquiredAt, FIXED_NOW);
    assert.equal(typeof payload.pid, "number");
    lock.release();
    assert.equal(fs.existsSync(paths.lockPath), false);
    lock.release();
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    temp.cleanup();
  }
});

test("reports lock-held without touching a fresh lock", () => {
  const temp = createTempBaseDirectory();
  try {
    const lockPath = plantLockFile(temp.baseDirectory, {
      acquiredAt: FIXED_NOW,
      pid: 4242,
    });
    const before = fs.readFileSync(lockPath, "utf8");
    const lock = acquireUpdateLock({
      baseDirectory: temp.baseDirectory,
      now: () => FIXED_NOW,
      staleMs: STALE_MS,
    });
    assert.equal(lock.ok, false);
    assert.equal(lock.code, "lock-held");
    assert.equal(fs.readFileSync(lockPath, "utf8"), before);
  } finally {
    temp.cleanup();
  }
});

test("reclaims a lock older than the stale bound", () => {
  const temp = createTempBaseDirectory();
  try {
    const lockPath = plantLockFile(temp.baseDirectory, {
      acquiredAt: FIXED_NOW - STALE_MS - 1,
      pid: 4242,
    });
    const lock = acquireUpdateLock({
      baseDirectory: temp.baseDirectory,
      now: () => FIXED_NOW,
      staleMs: STALE_MS,
    });
    assert.equal(lock.ok, true);
    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(payload.acquiredAt, FIXED_NOW);
    lock.release();
  } finally {
    temp.cleanup();
  }
});

test("treats an unreadable fresh lock as held", () => {
  const temp = createTempBaseDirectory();
  try {
    const paths = updateHomePaths(temp.baseDirectory);
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(paths.lockPath, "not json at all", "utf8");
    const lock = acquireUpdateLock({
      baseDirectory: temp.baseDirectory,
      now: () => Date.now(),
      staleMs: STALE_MS,
    });
    assert.equal(lock.ok, false);
    assert.equal(lock.code, "lock-held");
  } finally {
    temp.cleanup();
  }
});

test("falls back to file mtime when the lock payload is unreadable", () => {
  const temp = createTempBaseDirectory();
  try {
    const paths = updateHomePaths(temp.baseDirectory);
    fs.mkdirSync(paths.home, { recursive: true });
    fs.writeFileSync(paths.lockPath, "garbage", "utf8");
    const old = (Date.now() - STALE_MS - 1000) / 1000;
    fs.utimesSync(paths.lockPath, old, old);
    const lock = acquireUpdateLock({
      baseDirectory: temp.baseDirectory,
      now: () => Date.now(),
      staleMs: STALE_MS,
    });
    assert.equal(lock.ok, true);
    lock.release();
  } finally {
    temp.cleanup();
  }
});

test("classifies an unwritable base directory as a storage error", () => {
  const temp = createTempBaseDirectory();
  try {
    const filePath = `${temp.baseDirectory}.file`;
    fs.writeFileSync(filePath, "not a directory");
    try {
      const lock = acquireUpdateLock({
        baseDirectory: filePath,
        now: () => FIXED_NOW,
        staleMs: STALE_MS,
      });
      assert.equal(lock.ok, false);
      assert.equal(lock.code, "storage-error");
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  } finally {
    temp.cleanup();
  }
});
