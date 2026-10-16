import { activateProfileDirectory } from "../../src/main/profile-path.ts";

export const SID_ADA = "S-1-5-21-1000-2000-3000-1001";
export const SID_BOB = "S-1-5-21-1000-2000-3000-1002";
export const LAYOUT_BASE = {
  programDataDir: "C:\\ProgramData",
  machineRootFallback: "C:\\Fallback\\AppData",
};
export const LEGACY_BASE = {
  userProfile: "C:\\Users\\Ada",
  homeDir: "C:\\Users\\Ada",
  userName: "ada",
};

export function fakeFileSystem(entries = []) {
  const state = {
    directories: new Set(),
    files: new Set(),
    mkdirFails: false,
    mkdirFailPrefix: null,
    mkdtempFails: false,
    counter: 0,
  };
  for (const [candidate, kind] of entries) {
    (kind === "dir" ? state.directories : state.files).add(candidate);
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
      if (!state.files.has(candidate)) state.directories.add(candidate);
    },
    statSync: (candidate) => {
      if (state.files.has(candidate)) return { isDirectory: () => false };
      if (state.directories.has(candidate)) return { isDirectory: () => true };
      throw new Error(`ENOENT: ${candidate}`);
    },
    mkdtempSync: (prefix) => {
      if (state.mkdtempFails) throw new Error("ENOSPC: no space");
      const candidate = `${prefix}fake-${++state.counter}`;
      state.directories.add(candidate);
      return candidate;
    },
  };
}

export function activateWith(overrides = {}) {
  const fileSystem = overrides.fileSystem ?? fakeFileSystem();
  const sessionPaths = [];
  const userDataPaths = [];
  const activation = activateProfileDirectory({
    layout: LAYOUT_BASE,
    legacy: LEGACY_BASE,
    resolveSid: () => ({ ok: true, sid: SID_ADA }),
    hardenAcl: () => ({ ok: true }),
    setSessionDataPath: (directory) => sessionPaths.push(directory),
    setUserDataPath: (directory) => userDataPaths.push(directory),
    fileSystem,
    ...overrides,
  });
  return { activation, sessionPaths, userDataPaths, fileSystem };
}
