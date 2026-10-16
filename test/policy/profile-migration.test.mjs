import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  legacyProfileLeavesExist,
  legacyUserDirectory,
  resolveProfileLayout,
} from "../../src/main/profile-path.ts";
import {
  LAYOUT_BASE,
  LEGACY_BASE,
  SID_ADA,
  SID_BOB,
  activateWith,
  fakeFileSystem,
} from "./profile-test-fixtures.mjs";

test("legacy data is reported but never adopted", () => {
  const layout = resolveProfileLayout(LAYOUT_BASE, SID_ADA);
  const legacyDirectory = legacyUserDirectory(layout.machineRoot, LEGACY_BASE);
  const cookiePath = path.join(legacyDirectory, "profile", "Cookies");
  const fileSystem = fakeFileSystem([
    [legacyDirectory, "dir"],
    [path.join(legacyDirectory, "profile"), "dir"],
    [cookiePath, "file"],
  ]);

  const { activation } = activateWith({ fileSystem });

  assert.deepEqual(activation.migration, {
    legacyDirectory,
    freshDirectory: layout.userDirectory,
  });
  assert.equal(activation.usedFallback, false);
  assert.deepEqual([...fileSystem.state.files], [cookiePath]);
});

test("another account's SID directory alone raises no migration notice", () => {
  const other = resolveProfileLayout(LAYOUT_BASE, SID_BOB);
  const fileSystem = fakeFileSystem([[other.userDirectory, "dir"]]);
  const { activation } = activateWith({ fileSystem });
  assert.equal(activation.migration, null);
});

test("a legacy user-data leaf alone is enough to warrant the notice", () => {
  const layout = resolveProfileLayout(LAYOUT_BASE, SID_ADA);
  const legacyDirectory = legacyUserDirectory(layout.machineRoot, LEGACY_BASE);
  const fileSystem = fakeFileSystem([
    [path.join(legacyDirectory, "userdata"), "dir"],
  ]);
  const found = legacyProfileLeavesExist(
    layout.machineRoot,
    LEGACY_BASE,
    fileSystem,
  );
  assert.equal(found, true);
});

test("an unavailable SID uses the temp fallback and writes nothing persistent", () => {
  const { activation, fileSystem } = activateWith({
    resolveSid: () => ({ ok: false, reason: "identity query failed" }),
  });
  assert.equal(activation.usedFallback, true);
  assert.equal(activation.migration, null);
  assert.ok(activation.guidance !== null);
  const persistentWrites = [...fileSystem.state.directories].filter((entry) =>
    entry.startsWith("C:\\ProgramData"),
  );
  assert.deepEqual(persistentWrites, []);
});

test("identity failures on separate launches never reuse a temporary profile", () => {
  const fileSystem = fakeFileSystem();
  const options = {
    fileSystem,
    resolveSid: () => ({ ok: false, reason: "identity unavailable" }),
  };
  const first = activateWith(options);
  const second = activateWith(options);
  assert.notEqual(first.activation.directory, second.activation.directory);
  assert.notEqual(first.userDataPaths[0], second.userDataPaths[0]);
  assert.equal(first.activation.usedFallback, true);
  assert.equal(second.activation.usedFallback, true);
});
