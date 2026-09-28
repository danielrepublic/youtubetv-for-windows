/**
 * Private pending-update storage.
 *
 * A verified installer is written into a per-attempt directory named after a
 * random 128-bit nonce beneath an injectable base directory. Todo 6 supplies
 * the real profile path; this domain never assumes one. Directory modes are
 * requested as `0o700`/`0o600`, which is enforced on POSIX and accepted as a
 * best-effort hint on Windows.
 *
 * Creation is race-safe: `mkdir` without `recursive` fails if the nonce
 * directory already exists, and installer files are opened with the exclusive
 * `wx` flag, so a swapped or pre-planted path is never reused.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";

export interface UpdateHomePaths {
  /** Injectable base directory for all update state. */
  readonly home: string;
  readonly pendingRoot: string;
  readonly lockPath: string;
}

/** Derives every update path from the injectable base directory. */
export function updateHomePaths(baseDirectory: string): UpdateHomePaths {
  return {
    home: baseDirectory,
    pendingRoot: path.join(baseDirectory, "pending"),
    lockPath: path.join(baseDirectory, "update.lock"),
  };
}

/** 128-bit lowercase hex nonce; unpredictable and filesystem-safe. */
export function createNonce(): string {
  return randomBytes(16).toString("hex");
}

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type PendingDirectoryResult =
  | {
      readonly ok: true;
      readonly nonce: string;
      readonly directory: string;
    }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function restrictPermissions(target: string): void {
  try {
    chmodSync(target, 0o700);
  } catch {
    // Windows does not implement POSIX modes; the ACL on the injected base
    // directory is the real boundary there.
  }
}

/** Atomically creates an empty nonce directory for one update attempt. */
export function createPendingDirectory(
  baseDirectory: string,
  nonce?: string,
): PendingDirectoryResult {
  const chosen = nonce ?? createNonce();
  if (!NONCE_PATTERN.test(chosen)) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.STORAGE_ERROR,
      message:
        "the pending directory nonce must be 32 lowercase hex characters",
    };
  }
  const paths = updateHomePaths(baseDirectory);
  try {
    mkdirSync(paths.pendingRoot, { recursive: true, mode: 0o700 });
    const directory = path.join(paths.pendingRoot, chosen);
    // Non-recursive mkdir fails on EEXIST: a concurrent or replayed nonce can
    // never reuse a directory that already holds bytes.
    mkdirSync(directory, { mode: 0o700 });
    restrictPermissions(directory);
    return { ok: true, nonce: chosen, directory };
  } catch (error) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.STORAGE_ERROR,
      message: `could not create the pending update directory: ${describe(error)}`,
    };
  }
}

/** Best-effort removal of a pending directory and everything under it. */
export function removePendingDirectory(directory: string): void {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; a leftover nonce directory is inert and is
    // never reused because nonces are unpredictable.
  }
}

/** Path of the verified installer inside a pending directory. */
export function installerPathFor(directory: string, assetName: string): string {
  return path.join(directory, assetName);
}
