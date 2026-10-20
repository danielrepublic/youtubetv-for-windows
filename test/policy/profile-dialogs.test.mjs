// Pure-logic unit suite for the ProgramData profile layout convention and for
// the bilingual dialog catalog. The filesystem is faked, so corrupt and
// unwritable bases are exercised without touching the real disk, and the SID
// identity query is faked, so no test reads the real account SID.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const {
  PROFILE_DIRECTORY_NAME,
  USERS_DIRECTORY_NAME,
  SID_USERS_SEGMENT,
  PROFILE_SUBDIRECTORY_NAME,
  USER_DATA_SUBDIRECTORY_NAME,
  SESSION_DATA_PATH_NAME,
  USER_DATA_PATH_NAME,
  activateProfileDirectory,
  ensureFallbackProfileDirectory,
  ensureProfileDirectory,
  legacyUserDirectory,
  profileFallbackGuidance,
  resolveProfileLayout,
  sanitizeUserKey,
} = await import("../../src/main/profile-path.ts");

import {
  SID_ADA,
  SID_BOB,
  LAYOUT_BASE,
  LEGACY_BASE,
  fakeFileSystem,
  activateWith,
} from "./profile-test-fixtures.mjs";

const { SUPPORT_RELEASE_URL, profileFallbackDialog, routeFailureDialog } =
  await import("../../src/main/dialogs.ts");

test("the resolver fixes the machine root under PROGRAMDATA and a per-account SID level", () => {
  const layout = resolveProfileLayout(LAYOUT_BASE, SID_ADA);
  const machineRoot = path.join("C:\\ProgramData", PROFILE_DIRECTORY_NAME);
  const userDirectory = path.join(
    machineRoot,
    USERS_DIRECTORY_NAME,
    SID_USERS_SEGMENT,
    SID_ADA,
  );
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

test("two distinct SIDs map to two disjoint profile and user-data trees", () => {
  const ada = resolveProfileLayout(LAYOUT_BASE, SID_ADA);
  const bob = resolveProfileLayout(LAYOUT_BASE, SID_BOB);
  assert.notEqual(ada.profileDirectory, bob.profileDirectory);
  assert.notEqual(ada.userDataDirectory, bob.userDataDirectory);
});

test("accounts whose names sanitize to the same key no longer share a directory", () => {
  // The reported defect: these pairs produced ONE directory under the old
  // name-derived key. Identity is now the SID, so the persistent trees stay
  // disjoint no matter how the names collide.
  const collidingNamePairs = [
    ["\\Users\\王小明", "\\Users\\陳大文"],
    ["\\Users\\user name", "\\Users\\user_name"],
    ["D:\\Profiles\\Ada", "E:\\Mounted\\Ada"],
  ];
  for (const [left, right] of collidingNamePairs) {
    const leftLegacy = sanitizeUserKey(path.basename(left));
    const rightLegacy = sanitizeUserKey(path.basename(right));
    assert.equal(
      leftLegacy,
      rightLegacy,
      `precondition: both names must collide under the legacy key: ${left} / ${right}`,
    );
    const leftLayout = resolveProfileLayout(LAYOUT_BASE, SID_ADA);
    const rightLayout = resolveProfileLayout(LAYOUT_BASE, SID_BOB);
    assert.notEqual(leftLayout.userDirectory, rightLayout.userDirectory);
  }
});

test("a legacy account name can never alias a SID directory", () => {
  const machineRoot = path.join("C:\\ProgramData", PROFILE_DIRECTORY_NAME);
  const sidLayout = resolveProfileLayout(LAYOUT_BASE, SID_ADA);

  // A legacy account literally named like a SID.
  const sidShaped = legacyUserDirectory(machineRoot, {
    userProfile: `C:\\Users\\${SID_ADA}`,
    homeDir: "",
    userName: "",
  });
  assert.notEqual(sidShaped, sidLayout.userDirectory);

  // A legacy account literally named "by-sid" lands beside the SID level, not
  // inside it.
  const bySidShaped = legacyUserDirectory(machineRoot, {
    userProfile: "C:\\Users\\by-sid",
    homeDir: "",
    userName: "",
  });
  assert.notEqual(bySidShaped, sidLayout.userDirectory);
  assert.notEqual(
    path.join(bySidShaped, PROFILE_SUBDIRECTORY_NAME),
    sidLayout.profileDirectory,
  );
});

test("the legacy sanitizer stays a single safe segment", () => {
  const key = sanitizeUserKey("a/b\\c:d*e");
  assert.equal(key, "a_b_c_d_e");
  assert.equal(sanitizeUserKey("..."), "...");
  assert.equal(sanitizeUserKey(""), "user");
  assert.match(key, /^[A-Za-z0-9._-]+$/);
  assert.ok(!key.includes("/") && !key.includes("\\"), "single segment");
});

test("a blank or missing PROGRAMDATA falls back without producing a relative path", () => {
  for (const programDataDir of ["", undefined, null]) {
    const layout = resolveProfileLayout(
      { ...LAYOUT_BASE, programDataDir },
      SID_ADA,
    );
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

test("ensureProfileDirectory reports an existing but unwritable directory", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.writeFailPrefix = "C:\\base";
  const result = ensureProfileDirectory("C:\\base\\profile", fileSystem);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not writable/);
});

test("an existing but unwritable SID directory falls back to a temporary profile", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.writeFailPrefix = "C:\\ProgramData";
  const { activation, sessionPaths, userDataPaths } = activateWith({
    fileSystem,
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.equal(activation.migration, null);
  assert.ok(activation.guidance !== null);
  assert.ok(activation.directory.includes("youtubetv-for-windows-profile-"));
  assert.equal(sessionPaths.length, 1);
  assert.equal(userDataPaths.length, 1);
});

test("activation redirects BOTH data paths onto the SID directory", () => {
  const { activation, sessionPaths, userDataPaths } = activateWith();
  const userDirectory = path.join(
    "C:\\ProgramData",
    PROFILE_DIRECTORY_NAME,
    USERS_DIRECTORY_NAME,
    SID_USERS_SEGMENT,
    SID_ADA,
  );
  assert.equal(activation.usedFallback, false);
  assert.equal(activation.guidance, null);
  assert.equal(activation.migration, null);
  assert.equal(
    activation.directory,
    path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
  );
  assert.deepEqual(sessionPaths, [activation.directory]);
  assert.deepEqual(userDataPaths, [
    path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  ]);
});

test("a corrupt base falls back to a safe new profile pair with guidance", () => {
  const fileSystem = fakeFileSystem();
  fileSystem.state.mkdirFailPrefix = "C:\\Broken";
  const { activation, sessionPaths, userDataPaths } = activateWith({
    fileSystem,
    layout: { ...LAYOUT_BASE, programDataDir: "C:\\Broken\\ProgramData" },
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.equal(activation.migration, null);
  assert.ok(activation.directory.includes("youtubetv-for-windows-profile-"));
  assert.ok(activation.directory.endsWith("profile"));
  assert.equal(sessionPaths.length, 1);
  assert.equal(userDataPaths.length, 1);
  assert.notEqual(sessionPaths[0], userDataPaths[0]);
  assert.ok(userDataPaths[0].endsWith("userdata"));
  assert.ok(activation.guidance !== null);
  assert.match(activation.guidance.zhTW, /C:\\Broken\\ProgramData/);
});

test("a file where the profile directory belongs also triggers fallback", () => {
  const target = path.join(
    resolveProfileLayout(LAYOUT_BASE, SID_ADA).profileDirectory,
  );
  const fileSystem = fakeFileSystem([[target, "file"]]);
  const { activation } = activateWith({
    fileSystem,
    ensureFallback: (injected) => ensureFallbackProfileDirectory(injected),
  });
  assert.equal(activation.usedFallback, true);
  assert.ok(activation.guidance !== null);
});

test("activation throws only when even the fallback fails", () => {
  const fileSystem = fakeFileSystem();
  assert.throws(
    () =>
      activateProfileDirectory({
        layout: { ...LAYOUT_BASE, programDataDir: "C:\\Broken" },
        legacy: LEGACY_BASE,
        resolveSid: () => ({ ok: false, reason: "unavailable" }),
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
