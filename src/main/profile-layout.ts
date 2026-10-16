import fs from "node:fs";
import path from "node:path";

export const PROFILE_DIRECTORY_NAME = "youtubetv-for-windows";
export const USERS_DIRECTORY_NAME = "users";
export const SID_USERS_SEGMENT = "by-sid";
export const PROFILE_SUBDIRECTORY_NAME = "profile";
export const USER_DATA_SUBDIRECTORY_NAME = "userdata";
export const SESSION_DATA_PATH_NAME = "sessionData";
export const USER_DATA_PATH_NAME = "userData";

export interface ProfileLayoutInputs {
  readonly programDataDir: string | undefined | null;
  readonly machineRootFallback: string;
}

export interface LegacyProfileInputs {
  readonly userProfile: string | undefined | null;
  readonly homeDir: string;
  readonly userName: string;
}

export interface ProfileLayout {
  readonly machineRoot: string;
  readonly userDirectory: string;
  readonly profileDirectory: string;
  readonly userDataDirectory: string;
}

function firstNonBlank(
  ...values: (string | undefined | null)[]
): string | undefined {
  return values
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    ?.trim();
}

// This lossy key reconstructs legacy locations only, never persistent identity.
export function sanitizeUserKey(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" || sanitized === "." || sanitized === ".."
    ? "user"
    : sanitized;
}

export function resolveProfileLayout(
  inputs: ProfileLayoutInputs,
  userSid: string,
): ProfileLayout {
  const machineRoot = path.join(
    firstNonBlank(inputs.programDataDir) ?? inputs.machineRootFallback,
    PROFILE_DIRECTORY_NAME,
  );
  const userDirectory = path.join(
    machineRoot,
    USERS_DIRECTORY_NAME,
    SID_USERS_SEGMENT,
    userSid,
  );
  return {
    machineRoot,
    userDirectory,
    profileDirectory: path.join(userDirectory, PROFILE_SUBDIRECTORY_NAME),
    userDataDirectory: path.join(userDirectory, USER_DATA_SUBDIRECTORY_NAME),
  };
}

export function legacyUserDirectory(
  machineRoot: string,
  legacy: LegacyProfileInputs,
): string {
  const pathSource = firstNonBlank(legacy.userProfile, legacy.homeDir);
  const rawKey =
    pathSource === undefined ? legacy.userName : path.basename(pathSource);
  return path.join(machineRoot, USERS_DIRECTORY_NAME, sanitizeUserKey(rawKey));
}

export function legacyProfileLeavesExist(
  machineRoot: string,
  legacy: LegacyProfileInputs,
  fileSystem: { existsSync(candidate: string): boolean } = fs,
): boolean {
  const directory = legacyUserDirectory(machineRoot, legacy);
  return [PROFILE_SUBDIRECTORY_NAME, USER_DATA_SUBDIRECTORY_NAME].some((leaf) =>
    fileSystem.existsSync(path.join(directory, leaf)),
  );
}
