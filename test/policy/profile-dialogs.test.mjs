// Pure-logic unit suite for the ProgramData profile layout convention and for
// the bilingual dialog catalog. The filesystem is faked, so corrupt and
// unwritable bases are exercised without touching the real disk.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const {
  PROFILE_DIRECTORY_NAME,
  USERS_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
  USER_DATA_SUBDIRECTORY_NAME,
  SESSION_DATA_PATH_NAME,
  USER_DATA_PATH_NAME,
  activateProfileDirectory,
  ensureFallbackProfileDirectory,
  ensureProfileDirectory,
  profileFallbackGuidance,
  resolveProfileLayout,
  sanitizeUserKey,
} = await import("../../src/main/profile-path.ts");

const { SUPPORT_RELEASE_URL, profileFallbackDialog, routeFailureDialog } =
  await import("../../src/main/dialogs.ts");

// A deterministic, fully-specified layout input set. Production reads the env
// and os; the pure resolver takes them as inputs so the mapping is testable.
const LAYOUT_BASE = {
  programDataDir: "C:\\ProgramData",
  userProfile: "C:\\Users\\Ada",
  homeDir: "C:\\Users\\Ada",
  userName: "ada",
  machineRootFallback: "C:\\Fallback\\AppData",
};

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

test("the resolver fixes the machine root under PROGRAMDATA and a per-user key", () => {
  const layout = resolveProfileLayout(LAYOUT_BASE);
  const machineRoot = path.join("C:\\ProgramData", PROFILE_DIRECTORY_NAME);
  const userDirectory = path.join(machineRoot, USERS_DIRECTORY_NAME, "Ada");
  assert.equal(layout.machineRoot, machineRoot);
  assert.equal(layout.userDirectory, userDirectory);
  assert.equal(
    layout.profileDirectory,
    path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
  );
  assert.equal(
    layout.userDataDirectory,
    path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  );
  assert.ok(
    !layout.profileDirectory.match(/\d+\.\d+\.\d+/),
    "no version segment allowed",
  );
  assert.ok(
    !layout.profileDirectory.toLowerCase().includes("install"),
    "never under install",
  );
  assert.equal(SESSION_DATA_PATH_NAME, "sessionData");
  assert.equal(USER_DATA_PATH_NAME, "userData");
});

test("two distinct USERPROFILE values map to two distinct keys", () => {
  const ada = resolveProfileLayout({ ...LAYOUT_BASE });
  const bob = resolveProfileLayout({
    ...LAYOUT_BASE,
    userProfile: "D:\\Profiles\\Bob",
    homeDir: "D:\\Profiles\\Bob",
  });
  assert.equal(path.basename(ada.userDirectory), "Ada");
  assert.equal(path.basename(bob.userDirectory), "Bob");
  assert.notEqual(ada.profileDirectory, bob.profileDirectory);
  assert.notEqual(ada.userDataDirectory, bob.userDataDirectory);
});

test("a path-hostile USERPROFILE maps to a safe single-segment key", () => {
  const layout = resolveProfileLayout({
    ...LAYOUT_BASE,
    userProfile: "C:\\Users\\Ada Lovelace#1",
  });
  const key = path.basename(layout.userDirectory);
  assert.equal(key, "Ada_Lovelace_1");
  assert.match(key, /^[A-Za-z0-9._-]+$/);
  assert.ok(!key.includes("/") && !key.includes("\\"), "single path segment");
  // The sanitizer itself keeps the safe set and neutralises everything else,
  // and never returns an empty segment.
  assert.equal(sanitizeUserKey("a/b\\c:d*e"), "a_b_c_d_e");
  assert.equal(sanitizeUserKey("..."), "...");
  assert.equal(sanitizeUserKey(""), "user");
});

test("USERPROFILE falls back to the home directory and then the user name", () => {
  const fromHome = resolveProfileLayout({
    ...LAYOUT_BASE,
    userProfile: "",
    homeDir: "D:\\Profiles\\Grace",
  });
  assert.equal(path.basename(fromHome.userDirectory), "Grace");
  const fromUser = resolveProfileLayout({
    ...LAYOUT_BASE,
    userProfile: undefined,
    homeDir: "",
    userName: "Linus",
  });
  assert.equal(path.basename(fromUser.userDirectory), "Linus");
});

test("a blank or missing PROGRAMDATA falls back without producing a relative path", () => {
  for (const programDataDir of ["", undefined, null]) {
    const layout = resolveProfileLayout({
      ...LAYOUT_BASE,
      programDataDir,
    });
    assert.equal(
      layout.machineRoot,
      path.join("C:\\Fallback\\AppData", PROFILE_DIRECTORY_NAME),
    );
    assert.ok(
      path.isAbsolute(layout.profileDirectory),
      `a blank PROGRAMDATA must never resolve to a relative path: ${layout.profileDirectory}`,
    );
    assert.ok(path.isAbsolute(layout.userDataDirectory));
  }
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

test("activateProfileDirectory sets BOTH data paths before returning", () => {
  const fileSystem = fakeFileSystem();
  const sessionPaths = [];
  const userDataPaths = [];
  const activation = activateProfileDirectory({
    layout: LAYOUT_BASE,
    setSessionDataPath: (directory) => {
      sessionPaths.push(directory);
    },
    setUserDataPath: (directory) => {
      userDataPaths.push(directory);
    },
    fileSystem,
  });
  const userDirectory = path.join(
    "C:\\ProgramData",
    PROFILE_DIRECTORY_NAME,
    USERS_DIRECTORY_NAME,
    "Ada",
  );
  assert.equal(activation.usedFallback, false);
  assert.equal(activation.guidance, null);
  assert.equal(
    activation.directory,
    path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
  );
  assert.deepEqual(sessionPaths, [
    path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
  ]);
  assert.deepEqual(userDataPaths, [
    path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  ]);
});

test("a corrupt base falls back to a safe new profile pair with guidance", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.mkdirFailPrefix = "C:\\Broken";
  const sessionPaths = [];
  const userDataPaths = [];
  const activation = activateProfileDirectory({
    layout: { ...LAYOUT_BASE, programDataDir: "C:\\Broken\\ProgramData" },
    setSessionDataPath: (directory) => {
      sessionPaths.push(directory);
    },
    setUserDataPath: (directory) => {
      userDataPaths.push(directory);
    },
    fileSystem,
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.ok(activation.directory.includes("youtubetv-for-windows-profile-"));
  assert.ok(activation.directory.endsWith("profile"));
  assert.equal(sessionPaths.length, 1);
  assert.equal(userDataPaths.length, 1);
  assert.notEqual(sessionPaths[0], userDataPaths[0]);
  assert.ok(userDataPaths[0].endsWith("userdata"));
  assert.ok(activation.guidance !== null);
  assert.match(activation.guidance.zhTW, /暫時設定檔/);
  assert.match(activation.guidance.en, /temporary profile/);
  assert.match(activation.guidance.zhTW, /C:\\Broken\\ProgramData/);
});

test("a file where the profile directory belongs also triggers fallback", () => {
  const target = path.join(
    "C:\\ProgramData",
    PROFILE_DIRECTORY_NAME,
    USERS_DIRECTORY_NAME,
    "Ada",
    PROFILE_SUBDIRECTORY_NAME,
  );
  const fileSystem = fakeFileSystem([[target, "file"]]);
  const activation = activateProfileDirectory({
    layout: LAYOUT_BASE,
    setSessionDataPath: () => {},
    setUserDataPath: () => {},
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
        layout: { ...LAYOUT_BASE, programDataDir: "C:\\Broken" },
        setSessionDataPath: () => {},
        setUserDataPath: () => {},
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
