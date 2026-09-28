// Persistent per-user profile directory for the Electron session data.
//
// PROFILE PATH CONVENTION (fixed; mirrored by the NSIS uninstaller in a
// later todo, which must remove exactly this directory on uninstall):
//   %LOCALAPPDATA%\youtubetv-for-windows\profile
// resolved as
//   path.join(process.env.LOCALAPPDATA ?? app.getPath("appData"),
//            "youtubetv-for-windows", "profile")
// There is deliberately NO version segment in the path: the persisted
// browser profile must survive application updates, because the updater
// replaces only the versioned install directory while this directory lives
// outside of it. Never store the profile under the install directory.
//
// ACTIVATION ORDER: activateProfileDirectory() must run BEFORE the first
// session/partition access (session.fromPartition, or any BrowserWindow
// creation on the persistent partition), via app.setPath("sessionData", ...).
// Calling it later is a silent no-op for the already-created default
// session, which is exactly the class of bug the identity policy hit before
// the window was pinned to its partition.
//
// FALLBACK CONTRACT: if the resolved directory cannot be created or is not
// a directory (corrupt/missing/unwritable base), activation never throws.
// It falls back to a SAFE NEW profile directory under the OS temp dir with
// a nonce (mkdtemp), activates that instead, and reports
// { usedFallback: true, guidance } so the caller can show the bilingual
// profile-fallback guidance. The user keeps a working (fresh) session
// instead of a crashed startup.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE_DIRECTORY_NAME = "youtubetv-for-windows";
export const PROFILE_SUBDIRECTORY_NAME = "profile";
export const SESSION_DATA_PATH_NAME = "sessionData";

// UPDATE PATH CONVENTION (fixed; mirrored verbatim by the committed
// build/nsis.include and owed to the todo 7 uninstaller):
//
//   %LOCALAPPDATA%\youtubetv-for-windows\updates        <- nonce pending
//                                                          installers + lock
//   %LOCALAPPDATA%\youtubetv-for-windows\update-status  <- atomic post-install
//                                                          success markers
//
// Both are SIBLINGS of `profile` under the same version-independent per-user
// base, which is the parent directory of the profile directory. They are
// therefore outside any install directory (an update replaces only the
// versioned install tree) and are removed together with the profile by the
// uninstaller.
export const UPDATE_DIRECTORY_NAME = "updates";
export const UPDATE_STATUS_DIRECTORY_NAME = "update-status";

export interface UpdateDirectoryConvention {
  /** Base directory handed to the update domain (`checkForUpdate`). */
  readonly updateBaseDirectory: string;
  /** Directory holding atomic `success-<nonce>.json` markers. */
  readonly statusDirectory: string;
}

/** Derives the update directories from the activated profile directory. */
export function resolveUpdateDirectoryConvention(
  profileDirectory: string,
): UpdateDirectoryConvention {
  const userBaseDirectory = path.dirname(profileDirectory);
  return {
    updateBaseDirectory: path.join(userBaseDirectory, UPDATE_DIRECTORY_NAME),
    statusDirectory: path.join(userBaseDirectory, UPDATE_STATUS_DIRECTORY_NAME),
  };
}

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

// Pure resolver: joins the per-user base with the fixed two-segment suffix.
// localAppDataDir is process.env.LOCALAPPDATA in production; appDataFallback
// is app.getPath("appData"). Empty/blank env values fall through to the
// fallback so a blank variable cannot produce a relative profile path.
export function resolveProfileDirectory(
  localAppDataDir: string | undefined | null,
  appDataFallback: string,
): string {
  const base =
    typeof localAppDataDir === "string" && localAppDataDir.length > 0
      ? localAppDataDir
      : appDataFallback;
  return path.join(base, PROFILE_DIRECTORY_NAME, PROFILE_SUBDIRECTORY_NAME);
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

// Builds the safe-new fallback directory (OS temp dir + nonce) and ensures
// it. The nonce comes from mkdtemp so concurrent startups never share one.
export function ensureFallbackProfileDirectory(
  fileSystem: ProfileFileSystem = nodeFileSystem,
): { ok: true; directory: string } | { ok: false; reason: string } {
  let directory: string;
  try {
    directory = fileSystem.mkdtempSync(
      path.join(os.tmpdir(), `${PROFILE_DIRECTORY_NAME}-profile-`),
    );
  } catch (error) {
    return {
      ok: false,
      reason: `cannot create fallback profile directory: ${String(error)}`,
    };
  }
  const ensured = ensureProfileDirectory(directory, fileSystem);
  if (!ensured.ok) {
    return ensured;
  }
  return { ok: true, directory };
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
  localAppDataDir: string | undefined | null;
  appDataDir: string;
  setSessionDataPath: (directory: string) => void;
  fileSystem?: ProfileFileSystem;
  ensureFallback?: (
    fileSystem: ProfileFileSystem,
  ) => { ok: true; directory: string } | { ok: false; reason: string };
}

// Activates the persistent profile: resolves, ensures, then points Electron
// at it via setSessionDataPath (production: app.setPath("sessionData", …)).
// On corruption/creation failure uses the documented temp fallback and
// reports usedFallback + bilingual guidance. Only throws when even the
// fallback cannot be created (disk catastrophe); production still prefers
// to attempt startup and lets the caller decide.
export function activateProfileDirectory(
  deps: ProfileActivationDeps,
): ProfileActivation {
  const fileSystem = deps.fileSystem ?? nodeFileSystem;
  const directory = resolveProfileDirectory(
    deps.localAppDataDir,
    deps.appDataDir,
  );
  const ensured = ensureProfileDirectory(directory, fileSystem);
  if (ensured.ok) {
    deps.setSessionDataPath(directory);
    return { directory, usedFallback: false, guidance: null };
  }
  const fallback = (deps.ensureFallback ?? ensureFallbackProfileDirectory)(
    fileSystem,
  );
  if (!fallback.ok) {
    throw new Error(
      `profile activation failed for "${directory}" and the fallback failed too: ${fallback.reason}`,
    );
  }
  deps.setSessionDataPath(fallback.directory);
  return {
    directory: fallback.directory,
    usedFallback: true,
    guidance: profileFallbackGuidance(directory),
  };
}

// Production adapter over the Electron app object. Reads LOCALAPPDATA from
// the environment (the documented convention) with app.getPath("appData")
// as the fallback, then redirects Electron's session data before any
// session is opened. This is the ONLY sanctioned environment-variable read
// in src/: it selects a per-user data directory, never a runtime override,
// and the no-override suite allowlists exactly this variable name in this
// file (see test/electron/secure-host.test.mjs).
export interface ElectronProfileApp {
  getPath(name: string): string;
  setPath(name: string, value: string): void;
}

export function activateProductionProfile(
  electronApp: ElectronProfileApp,
): ProfileActivation {
  return activateProfileDirectory({
    localAppDataDir: process.env.LOCALAPPDATA,
    appDataDir: electronApp.getPath("appData"),
    setSessionDataPath: (directory) => {
      electronApp.setPath(SESSION_DATA_PATH_NAME, directory);
    },
  });
}
