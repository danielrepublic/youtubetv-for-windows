// Pure-logic unit suite for the profile path convention and for the
// bilingual dialog catalog. The filesystem is faked, so corrupt and
// unwritable bases are exercised without touching the real disk.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const {
  PROFILE_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
  SESSION_DATA_PATH_NAME,
  activateProfileDirectory,
  ensureFallbackProfileDirectory,
  ensureProfileDirectory,
  profileFallbackGuidance,
  resolveProfileDirectory,
} = await import("../../src/main/profile-path.ts");

const { SUPPORT_RELEASE_URL, profileFallbackDialog, routeFailureDialog } =
  await import("../../src/main/dialogs.ts");

function fakeFileSystem(entries) {
  // entries: Map from absolute path -> "dir" | "file". mkdirSync creates
  // dirs unless the factory is told to fail; mkdtempSync mints /tmp/fake-N.
  const state = {
    directories: new Set(),
    files: new Set(),
    mkdirFails: false,
    mkdirFailPrefix: null,
    mkdtempFails: false,
    counter: 0,
  };
  for (const [candidate, kind] of entries ?? []) {
    if (kind === "dir") {
      state.directories.add(candidate);
    } else {
      state.files.add(candidate);
    }
  }
  return {
    state,
    existsSync: (candidate) =>
      state.directories.has(candidate) || state.files.has(candidate),
    mkdirSync: (candidate) => {
      if (
        state.mkdirFails ||
        (state.mkdirFailPrefix !== null &&
          candidate.startsWith(state.mkdirFailPrefix))
      ) {
        throw new Error("EACCES: permission denied");
      }
      if (state.files.has(candidate)) {
        return undefined;
      }
      state.directories.add(candidate);
      return undefined;
    },
    statSync: (candidate) => {
      if (state.files.has(candidate)) {
        return { isDirectory: () => false };
      }
      if (state.directories.has(candidate)) {
        return { isDirectory: () => true };
      }
      const error = new Error(`ENOENT: ${candidate}`);
      throw error;
    },
    mkdtempSync: (prefix) => {
      if (state.mkdtempFails) {
        throw new Error("ENOSPC: no space");
      }
      state.counter += 1;
      const candidate = `${prefix}fake-${state.counter}`;
      state.directories.add(candidate);
      return candidate;
    },
  };
}

test("the resolver fixes the version-independent per-user convention", () => {
  const resolved = resolveProfileDirectory(
    "C:\\Users\\Ada\\AppData\\Local",
    "FALLBACK",
  );
  assert.equal(
    resolved,
    path.join(
      "C:\\Users\\Ada\\AppData\\Local",
      "youtubetv-for-windows",
      "profile",
    ),
  );
  assert.ok(!resolved.match(/\d+\.\d+\.\d+/), "no version segment allowed");
  assert.ok(!resolved.toLowerCase().includes("install"), "never under install");
  // Blank env falls through to the appData fallback instead of a relative path.
  assert.equal(
    resolveProfileDirectory("", "C:\\Fallback\\AppData"),
    path.join(
      "C:\\Fallback\\AppData",
      PROFILE_DIRECTORY_NAME,
      PROFILE_SUBDIRECTORY_NAME,
    ),
  );
  assert.equal(
    resolveProfileDirectory(undefined, "C:\\Fallback\\AppData"),
    path.join(
      "C:\\Fallback\\AppData",
      PROFILE_DIRECTORY_NAME,
      PROFILE_SUBDIRECTORY_NAME,
    ),
  );
  assert.equal(SESSION_DATA_PATH_NAME, "sessionData");
});

test("ensureProfileDirectory creates, validates, and reports reasons", () => {
  const fresh = fakeFileSystem();
  assert.deepEqual(ensureProfileDirectory("C:\\base\\profile", fresh), {
    ok: true,
  });
  const fileBlocked = fakeFileSystem([["C:\\base\\profile", "file"]]);
  const blocked = ensureProfileDirectory("C:\\base\\profile", fileBlocked);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /not a directory/);
  const unwritable = fakeFileSystem();
  unwritable.state.mkdirFails = true;
  const failed = ensureProfileDirectory("C:\\base\\profile", unwritable);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /cannot create/);
});

test("activateProfileDirectory sets the session path before returning", () => {
  const fileSystem = fakeFileSystem();
  const setPaths = [];
  const activation = activateProfileDirectory({
    localAppDataDir: "C:\\Users\\Ada\\AppData\\Local",
    appDataDir: "C:\\Fallback",
    setSessionDataPath: (directory) => {
      setPaths.push(directory);
    },
    fileSystem,
  });
  assert.equal(activation.usedFallback, false);
  assert.equal(activation.guidance, null);
  assert.equal(
    activation.directory,
    path.join(
      "C:\\Users\\Ada\\AppData\\Local",
      "youtubetv-for-windows",
      "profile",
    ),
  );
  assert.deepEqual(setPaths, [activation.directory]);
});

test("a corrupt base falls back to a safe new profile with guidance", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.mkdirFailPrefix = "C:\\Broken";
  const setPaths = [];
  const activation = activateProfileDirectory({
    localAppDataDir: "C:\\Broken\\Local",
    appDataDir: "C:\\Fallback",
    setSessionDataPath: (directory) => {
      setPaths.push(directory);
    },
    fileSystem,
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.ok(activation.directory.includes("youtubetv-for-windows-profile-"));
  assert.deepEqual(setPaths, [activation.directory]);
  assert.ok(activation.guidance !== null);
  assert.match(activation.guidance.zhTW, /暫時設定檔/);
  assert.match(activation.guidance.en, /temporary profile/);
  assert.match(activation.guidance.zhTW, /C:\\Broken\\Local/);
});

test("a file where the profile directory belongs also triggers fallback", () => {
  const target = path.join(
    "C:\\Users\\Ada\\AppData\\Local",
    "youtubetv-for-windows",
    "profile",
  );
  const fileSystem = fakeFileSystem([[target, "file"]]);
  const activation = activateProfileDirectory({
    localAppDataDir: "C:\\Users\\Ada\\AppData\\Local",
    appDataDir: "C:\\Fallback",
    setSessionDataPath: () => {},
    fileSystem,
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.ok(activation.guidance !== null);
});

test("activation throws only when even the fallback fails", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.mkdirFails = true;
  assert.throws(
    () =>
      activateProfileDirectory({
        localAppDataDir: "C:\\Broken",
        appDataDir: "C:\\Fallback",
        setSessionDataPath: () => {},
        fileSystem,
        ensureFallback: () => ({ ok: false, reason: "disk catastrophe" }),
      }),
    /fallback failed too/,
  );
});

test("the fallback guidance is bilingual", () => {
  const guidance = profileFallbackGuidance("C:\\Broken");
  assert.match(guidance.zhTW, /無法使用/);
  assert.match(guidance.en, /unavailable/);
});

test("the route-failure dialog carries both languages and three actions", () => {
  for (const kind of ["redirected-away", "load-failed"]) {
    const content = routeFailureDialog(kind);
    assert.match(content.title, /無法載入/);
    assert.match(content.title, /failed to load/);
    assert.match(content.message, /\n/);
    assert.deepEqual(content.buttons, [
      "重試 (Retry)",
      "在瀏覽器中開啟 (Open in browser)",
      "支援 (Support)",
    ]);
    assert.match(content.detail, /github\.com/);
  }
  assert.equal(
    SUPPORT_RELEASE_URL,
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  );
});

test("the profile-fallback dialog names both directories bilingually", () => {
  const content = profileFallbackDialog("C:\\Broken", "C:\\Temp\\fresh");
  assert.match(content.title, /設定檔/);
  assert.match(content.title, /Profile/);
  assert.match(content.message, /C:\\Broken/);
  assert.match(content.message, /C:\\Temp\\fresh/);
  assert.deepEqual(content.buttons, ["確定 (OK)"]);
});
