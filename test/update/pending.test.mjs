import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createNonce,
  createPendingDirectory,
  installerPathFor,
  removePendingDirectory,
  updateHomePaths,
} from "../../src/main/update/pending.ts";
import { createTempBaseDirectory } from "./fixture-helpers.mjs";

test("generates a 128-bit lowercase hex nonce", () => {
  const first = createNonce();
  const second = createNonce();
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
});

test("derives lock and pending paths from the injected base directory", () => {
  const paths = updateHomePaths("C:\\base");
  assert.equal(paths.home, "C:\\base");
  assert.equal(paths.pendingRoot, path.join("C:\\base", "pending"));
  assert.equal(paths.lockPath, path.join("C:\\base", "update.lock"));
});

test("creates a nonce directory beneath the pending root", () => {
  const temp = createTempBaseDirectory();
  try {
    const result = createPendingDirectory(temp.baseDirectory, "a".repeat(32));
    assert.equal(result.ok, true);
    assert.equal(result.nonce, "a".repeat(32));
    const paths = updateHomePaths(temp.baseDirectory);
    assert.equal(
      result.directory,
      path.join(paths.pendingRoot, "a".repeat(32)),
    );
    assert.equal(fs.statSync(result.directory).isDirectory(), true);
    assert.equal(
      installerPathFor(result.directory, "installer.exe"),
      path.join(result.directory, "installer.exe"),
    );
  } finally {
    temp.cleanup();
  }
});

test("creates nested base directories when needed", () => {
  const temp = createTempBaseDirectory();
  try {
    const nested = path.join(temp.baseDirectory, "profile", "updates");
    const result = createPendingDirectory(nested);
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.directory), true);
  } finally {
    temp.cleanup();
  }
});

test("refuses to reuse an existing nonce directory", () => {
  const temp = createTempBaseDirectory();
  try {
    const nonce = "b".repeat(32);
    const first = createPendingDirectory(temp.baseDirectory, nonce);
    assert.equal(first.ok, true);
    const second = createPendingDirectory(temp.baseDirectory, nonce);
    assert.equal(second.ok, false);
    assert.equal(second.code, "storage-error");
  } finally {
    temp.cleanup();
  }
});

test("rejects a nonce that could escape the pending root", () => {
  const temp = createTempBaseDirectory();
  try {
    for (const nonce of ["..", "../evil", "ABCDEF", "a".repeat(31)]) {
      const result = createPendingDirectory(temp.baseDirectory, nonce);
      assert.equal(result.ok, false, `accepted nonce ${nonce}`);
      assert.equal(result.code, "storage-error");
    }
  } finally {
    temp.cleanup();
  }
});

test("removes a pending directory recursively", () => {
  const temp = createTempBaseDirectory();
  try {
    const result = createPendingDirectory(temp.baseDirectory);
    assert.equal(result.ok, true);
    fs.writeFileSync(
      installerPathFor(result.directory, "installer.exe"),
      "payload",
    );
    removePendingDirectory(result.directory);
    assert.equal(fs.existsSync(result.directory), false);
    removePendingDirectory(result.directory);
  } finally {
    temp.cleanup();
  }
});
