// Persistent per-machine application data layout for the Electron session
// profile and user-data directories.
//
// MACHINE PATH CONVENTION (fixed; the NSIS installer creates and ACLs the
// machine root, and the uninstaller removes it):
//   %PROGRAMDATA%\youtubetv-for-windows\users\<key>\profile   (sessionData)
//   %PROGRAMDATA%\youtubetv-for-windows\users\<key>\userdata  (userData)
//
// <key> is a per-Windows-user segment derived in userKey() below. The machine
// root under %PROGRAMDATA% is machine-wide (the installer grants the local
// Users group modify, because an elevated installer otherwise creates a folder
// a standard user can only read); the per-user <key> segment is what keeps two
// concurrent Windows users from sharing one Chromium user-data directory.
// Chromium's Windows single-instance protection is a `lockfile` inside the
// user-data directory plus a message-only window, and Electron only takes it
// when app.requestSingleInstanceLock() is called, so a shared directory lets a
// second signed-in user corrupt the first user's profile.
//
// There is deliberately NO version segment in the path: the persisted browser
// profile must survive application replacement, because the installer replaces
// only the versioned install directory while this tree lives outside of it.
// Never store the profile under the install directory.
//
// ACTIVATION ORDER: activateProfileDirectory() must run BEFORE the first
// session/partition access (session.fromPartition, or any BrowserWindow
// creation on the persistent partition), via app.setPath("sessionData", ...)
// and app.setPath("userData", ...). Calling it later is a silent no-op for the
// already-created default session, which is exactly the class of bug the
// identity policy hit before the window was pinned to its partition.
//
// FALLBACK CONTRACT: if either resolved directory cannot be created or is not
// a directory (corrupt/missing/unwritable base), activation never throws. It
// falls back to a SAFE NEW directory pair under the OS temp dir with a nonce
// (mkdtemp), activates those instead, and reports
// { usedFallback: true, guidance } so the caller can show the bilingual
// profile-fallback guidance. The user keeps a working (fresh) session instead
// of a crashed startup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE_DIRECTORY_NAME = "youtubetv-for-windows";
export const USERS_DIRECTORY_NAME = "users";
export const PROFILE_SUBDIRECTORY_NAME = "profile";
export const USER_DATA_SUBDIRECTORY_NAME = "userdata";
export const SESSION_DATA_PATH_NAME = "sessionData";
export const USER_DATA_PATH_NAME = "userData";

export interface BilingualGuidance {
  zhTW: string;
  en: string;
}

export interface ProfileActivation {
  directory: string;
  usedFallback: boolean;
  guidance: BilingualGuidance | null;
}

// Minimal filesystem surface, injectable so tests can simulate an
// unwritable or corrupt base without touching the real disk or Electron.
export interface ProfileFileSystem {
  existsSync(candidate: string): boolean;
  mkdirSync(candidate: string, options?: { recursive?: boolean }): unknown;
  statSync(candidate: string): { isDirectory(): boolean };
  mkdtempSync(prefix: string): string;
}

const nodeFileSystem: ProfileFileSystem = {
  existsSync: (candidate) => fs.existsSync(candidate),
  mkdirSync: (candidate, options) => fs.mkdirSync(candidate, options),
  statSync: (candidate) => fs.statSync(candidate),
  mkdtempSync: (prefix) => fs.mkdtempSync(prefix),
};

export interface ProfileLayoutInputs {
  // %PROGRAMDATA% in production; blank/missing falls through to
  // machineRootFallback so it can never produce a relative path.
  programDataDir: string | undefined | null;
  // The per-Windows-user key sources, in priority order (see userKey()).
  userProfile: string | undefined | null;
  homeDir: string;
  userName: string;
  // Absolute directory used only when programDataDir is blank/missing
  // (production passes app.getPath("appData")).
  machineRootFallback: string;
}

export interface ProfileLayout {
  machineRoot: string;
  userDirectory: string;
  profileDirectory: string;
  userDataDirectory: string;
}

function firstNonBlank(
  ...values: (string | undefined | null)[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

// Sanitizes a Windows user key into a single path segment: every character
// outside [A-Za-z0-9._-] (including path separators, colons and spaces)
// becomes "_". The result is never empty and is never the "." or ".."
// navigation segment, so the key always names exactly one ordinary directory
// level and cannot be used to address a parent of the users\<key> room.
export function sanitizeUserKey(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return "user";
  }
  return sanitized;
}

// Pure resolver: builds the machine root, the per-user directory, and the two
// sibling data directories under it. programDataDir is process.env.PROGRAMDATA
// in production; a blank/missing value falls through to the absolute
// machineRootFallback. The per-user key comes from the basename of
// userProfile, then the basename of homeDir, then userName, sanitized into a
// single segment.
export function resolveProfileLayout(
  inputs: ProfileLayoutInputs,
): ProfileLayout {
  const rootBase =
    firstNonBlank(inputs.programDataDir) ?? inputs.machineRootFallback;
  const machineRoot = path.join(rootBase, PROFILE_DIRECTORY_NAME);
  const pathSource = firstNonBlank(inputs.userProfile, inputs.homeDir);
  const rawKey =
    pathSource === undefined ? inputs.userName : path.basename(pathSource);
  const userDirectory = path.join(
    machineRoot,
    USERS_DIRECTORY_NAME,
    sanitizeUserKey(rawKey),
  );
  return {
    machineRoot,
    userDirectory,
    profileDirectory: path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
    userDataDirectory: path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  };
}

// Ensures the directory exists and is a directory. Returns a reason string
// instead of throwing so the caller can choose the documented fallback.
export function ensureProfileDirectory(
  directory: string,
  fileSystem: ProfileFileSystem = nodeFileSystem,
): { ok: true } | { ok: false; reason: string } {
  try {
    fileSystem.mkdirSync(directory, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: `cannot create profile directory: ${String(error)}`,
    };
  }
  let isDirectory: boolean;
  try {
    isDirectory = fileSystem.statSync(directory).isDirectory();
  } catch (error) {
    return {
      ok: false,
      reason: `cannot inspect profile directory: ${String(error)}`,
    };
  }
  if (!isDirectory) {
    return {
      ok: false,
      reason: "profile path exists but is not a directory",
    };
  }
  return { ok: true };
}

export interface FallbackDirectories {
  profileDirectory: string;
  userDataDirectory: string;
}

export type FallbackResult =
  ({ ok: true } & FallbackDirectories) | { ok: false; reason: string };

// Builds the safe-new fallback directory pair (OS temp dir + nonce) and
// ensures both children. The nonce comes from mkdtemp so concurrent startups
// never share one, and the pair mirrors the production <dir>\profile +
// <dir>\userdata shape.
export function ensureFallbackProfileDirectory(
  fileSystem: ProfileFileSystem = nodeFileSystem,
): FallbackResult {
  let root: string;
  try {
    root = fileSystem.mkdtempSync(
      path.join(os.tmpdir(), `${PROFILE_DIRECTORY_NAME}-profile-`),
    );
  } catch (error) {
    return {
      ok: false,
      reason: `cannot create fallback profile directory: ${String(error)}`,
    };
  }
  const profileDirectory = path.join(root, PROFILE_SUBDIRECTORY_NAME);
  const profileEnsured = ensureProfileDirectory(profileDirectory, fileSystem);
  if (!profileEnsured.ok) {
    return profileEnsured;
  }
  const userDataDirectory = path.join(root, USER_DATA_SUBDIRECTORY_NAME);
  const userDataEnsured = ensureProfileDirectory(userDataDirectory, fileSystem);
  if (!userDataEnsured.ok) {
    return userDataEnsured;
  }
  return { ok: true, profileDirectory, userDataDirectory };
}

export function profileFallbackGuidance(
  failedDirectory: string,
): BilingualGuidance {
  return {
    zhTW:
      `無法使用設定檔目錄（${failedDirectory}），已改用暫時設定檔繼續啟動。` +
      `書籤與登入狀態不會保留在此次工作階段，建議檢查磁碟權限後重新啟動。`,
    en:
      `The profile directory (${failedDirectory}) is unavailable, so the app ` +
      `started with a temporary profile. Sign-in state will not persist for ` +
      `this session; check disk permissions and restart.`,
  };
}

export interface ProfileActivationDeps {
  layout: ProfileLayoutInputs;
  setSessionDataPath: (directory: string) => void;
  setUserDataPath: (directory: string) => void;
  fileSystem?: ProfileFileSystem;
  ensureFallback?: (fileSystem: ProfileFileSystem) => FallbackResult;
}

function activateFallback(
  deps: ProfileActivationDeps,
  fileSystem: ProfileFileSystem,
  layout: ProfileLayout,
): ProfileActivation {
  const fallback = (deps.ensureFallback ?? ensureFallbackProfileDirectory)(
    fileSystem,
  );
  if (!fallback.ok) {
    throw new Error(
      `profile activation failed for "${layout.profileDirectory}" and the fallback failed too: ${fallback.reason}`,
    );
  }
  deps.setSessionDataPath(fallback.profileDirectory);
  deps.setUserDataPath(fallback.userDataDirectory);
  return {
    directory: fallback.profileDirectory,
    usedFallback: true,
    guidance: profileFallbackGuidance(layout.profileDirectory),
  };
}

// Activates the persistent layout: resolves, ensures BOTH directories, then
// points Electron at them via setSessionDataPath / setUserDataPath
// (production: app.setPath("sessionData", …) and app.setPath("userData", …)).
// On corruption/creation failure of either directory it uses the documented
// temp fallback and reports usedFallback + bilingual guidance. Only throws when
// even the fallback cannot be created (disk catastrophe); production still
// prefers to attempt startup and lets the caller decide.
export function activateProfileDirectory(
  deps: ProfileActivationDeps,
): ProfileActivation {
  const fileSystem = deps.fileSystem ?? nodeFileSystem;
  const layout = resolveProfileLayout(deps.layout);
  const profileEnsured = ensureProfileDirectory(
    layout.profileDirectory,
    fileSystem,
  );
  if (!profileEnsured.ok) {
    return activateFallback(deps, fileSystem, layout);
  }
  const userDataEnsured = ensureProfileDirectory(
    layout.userDataDirectory,
    fileSystem,
  );
  if (!userDataEnsured.ok) {
    return activateFallback(deps, fileSystem, layout);
  }
  deps.setSessionDataPath(layout.profileDirectory);
  deps.setUserDataPath(layout.userDataDirectory);
  return {
    directory: layout.profileDirectory,
    usedFallback: false,
    guidance: null,
  };
}

// Production adapter over the Electron app object. Reads PROGRAMDATA and
// USERPROFILE from the environment (the documented convention) with the home
// directory and OS user name as USERPROFILE fallbacks and app.getPath("appData")
// as the blank-PROGRAMDATA fallback, then redirects BOTH Electron data paths
// before any session is opened. These are the ONLY sanctioned
// environment-variable reads in src/: they select a per-user data directory,
// never a runtime override, and the no-override suite allowlists exactly these
// variable names in this file (see test/electron/secure-host.test.mjs).
export interface ElectronProfileApp {
  getPath(name: string): string;
  setPath(name: string, value: string): void;
}

export function activateProductionProfile(
  electronApp: ElectronProfileApp,
): ProfileActivation {
  return activateProfileDirectory({
    layout: {
      programDataDir: process.env.PROGRAMDATA,
      userProfile: process.env.USERPROFILE,
      homeDir: os.homedir(),
      userName: os.userInfo().username,
      machineRootFallback: electronApp.getPath("appData"),
    },
    setSessionDataPath: (directory) => {
      electronApp.setPath(SESSION_DATA_PATH_NAME, directory);
    },
    setUserDataPath: (directory) => {
      electronApp.setPath(USER_DATA_PATH_NAME, directory);
    },
  });
}
