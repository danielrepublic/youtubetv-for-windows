// Persistent per-machine application data layout for the Electron session
// profile and user-data directories.
//
// MACHINE PATH CONVENTION (fixed; the NSIS installer creates and ACLs the
// machine root, and the uninstaller removes it):
//   %PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\profile
//   %PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\userdata
//
// <SID> is the stable security identifier of the Windows account the process
// runs as, read once in windows-user-identity.ts. The machine root under
// %PROGRAMDATA% is machine-wide (the installer grants the local Users group
// modify, because an elevated installer otherwise creates a folder a standard
// user can only read); the per-account SID segment is what keeps two concurrent
// Windows users from sharing one Chromium user-data directory. An account name
// cannot do that job: any two names that sanitize to the same characters --
// equal-length non-ASCII names, "user name" and "user_name", one profile name
// under two different roots -- produced ONE shared directory. Chromium's
// Windows single-instance protection is a `lockfile` inside the user-data
// directory plus a message-only window, and Electron only takes it when
// app.requestSingleInstanceLock() is called, so a shared directory lets a
// second signed-in user corrupt the first user's profile. The by-sid level is
// structural, so a legacy account literally NAMED "by-sid" cannot alias a SID
// directory either.
//
// LEGACY DATA: earlier releases keyed the tree by account name under
// users\<name>\. Those directories are never read, copied, adopted, merged, or
// deleted. Detection only informs the user that legacy sign-in state is not
// transferred to the SID directory. An
// identity that cannot be obtained never falls back to a name-derived
// persistent key: it uses the temp fallback, so identity failure can never make
// two users share one profile.
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
import type { SidResult } from "./windows-user-identity.ts";
import { resolveCurrentUserSidSync } from "./windows-user-identity.ts";
import type {
  LegacyProfileInputs,
  ProfileLayoutInputs,
} from "./profile-layout.ts";
import {
  PROFILE_DIRECTORY_NAME,
  PROFILE_SUBDIRECTORY_NAME,
  USER_DATA_SUBDIRECTORY_NAME,
  SESSION_DATA_PATH_NAME,
  USER_DATA_PATH_NAME,
  legacyProfileLeavesExist,
  legacyUserDirectory,
  resolveProfileLayout,
} from "./profile-layout.ts";
export * from "./profile-layout.ts";

export interface BilingualGuidance {
  zhTW: string;
  en: string;
}

export interface ProfileMigrationNotice {
  // The untouched pre-SID directory, named so the user can find it, and the
  // fresh SID directory that starts empty and needs a re-login.
  legacyDirectory: string;
  freshDirectory: string;
}

export interface ProfileActivation {
  directory: string;
  usedFallback: boolean;
  guidance: BilingualGuidance | null;
  // Non-null exactly when a SID directory was activated AND legacy
  // name-keyed data still exists. Null on the temp fallback, which persists
  // nothing and therefore promises no re-login.
  migration: ProfileMigrationNotice | null;
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
  legacy: LegacyProfileInputs;
  setSessionDataPath: (directory: string) => void;
  setUserDataPath: (directory: string) => void;
  // The identity seam, injectable so tests can simulate an unavailable SID
  // without touching the real one.
  resolveSid?: () => SidResult;
  fileSystem?: ProfileFileSystem;
  ensureFallback?: (fileSystem: ProfileFileSystem) => FallbackResult;
}

function activateFallback(
  deps: ProfileActivationDeps,
  fileSystem: ProfileFileSystem,
  failedDirectory: string,
): ProfileActivation {
  const fallback = (deps.ensureFallback ?? ensureFallbackProfileDirectory)(
    fileSystem,
  );
  if (!fallback.ok) {
    throw new Error(
      `profile activation failed for "${failedDirectory}" and the fallback failed too: ${fallback.reason}`,
    );
  }
  deps.setSessionDataPath(fallback.profileDirectory);
  deps.setUserDataPath(fallback.userDataDirectory);
  return {
    directory: fallback.profileDirectory,
    usedFallback: true,
    guidance: profileFallbackGuidance(failedDirectory),
    migration: null,
  };
}

// Activates the persistent layout: obtains the SID, resolves, ensures BOTH
// directories, then points Electron at them via setSessionDataPath /
// setUserDataPath (production: app.setPath("sessionData", …) and
// app.setPath("userData", …)). An unavailable identity, or corruption/creation
// failure of either directory, uses the documented temp fallback and reports
// usedFallback + bilingual guidance. Only throws when even the fallback cannot
// be created (disk catastrophe); production still prefers to attempt startup
// and lets the caller decide.
export function activateProfileDirectory(
  deps: ProfileActivationDeps,
): ProfileActivation {
  const fileSystem = deps.fileSystem ?? nodeFileSystem;
  const sid = (deps.resolveSid ?? resolveCurrentUserSidSync)();
  if (!sid.ok) {
    return activateFallback(
      deps,
      fileSystem,
      `the per-account profile directory for this Windows identity (${sid.reason})`,
    );
  }
  const layout = resolveProfileLayout(deps.layout, sid.sid);
  const profileEnsured = ensureProfileDirectory(
    layout.profileDirectory,
    fileSystem,
  );
  if (!profileEnsured.ok) {
    return activateFallback(deps, fileSystem, layout.profileDirectory);
  }
  const userDataEnsured = ensureProfileDirectory(
    layout.userDataDirectory,
    fileSystem,
  );
  if (!userDataEnsured.ok) {
    return activateFallback(deps, fileSystem, layout.userDataDirectory);
  }
  deps.setSessionDataPath(layout.profileDirectory);
  deps.setUserDataPath(layout.userDataDirectory);
  const legacyExists = legacyProfileLeavesExist(
    layout.machineRoot,
    deps.legacy,
    fileSystem,
  );
  return {
    directory: layout.profileDirectory,
    usedFallback: false,
    guidance: null,
    migration: legacyExists
      ? {
          legacyDirectory: legacyUserDirectory(layout.machineRoot, deps.legacy),
          freshDirectory: layout.userDirectory,
        }
      : null,
  };
}

// Production adapter over the Electron app object. Reads PROGRAMDATA and
// USERPROFILE from the environment (the documented convention) with the home
// directory and OS user name as USERPROFILE fallbacks and app.getPath("appData")
// as the blank-PROGRAMDATA fallback, obtains the account SID, then redirects
// BOTH Electron data paths before any session is opened. These are the ONLY
// sanctioned environment-variable reads in src/ (the SID query reads SystemRoot
// in windows-user-identity.ts, for the system directory only): they select a
// per-account data directory, never a runtime override, and the no-override
// suite allowlists exactly these variable names in this file (see
// test/electron/secure-host.test.mjs).
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
      machineRootFallback: electronApp.getPath("appData"),
    },
    legacy: {
      userProfile: process.env.USERPROFILE,
      homeDir: os.homedir(),
      userName: os.userInfo().username,
    },
    setSessionDataPath: (directory) => {
      electronApp.setPath(SESSION_DATA_PATH_NAME, directory);
    },
    setUserDataPath: (directory) => {
      electronApp.setPath(USER_DATA_PATH_NAME, directory);
    },
  });
}
