/**
 * Per-user update lock.
 *
 * The lock is a single file created atomically with `openSync(path, "wx")`.
 * Only the first concurrent update attempt can create it; every other attempt
 * gets the `lock-held` classified result and touches no update state.
 *
 * A crashed attempt must not deadlock every future launch, so a lock older
 * than `staleMs` (measured against the injected clock, falling back to file
 * mtime if the payload is unreadable) is reclaimed once. If the lock is
 * unreadable AND its mtime cannot be stat'ed, the lock is treated as held:
 * failing closed is always preferable to double-applying an update.
 *
 * `release()` is idempotent and must be called on every terminal path.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import { updateHomePaths } from "./pending.ts";

export type LockAcquisition =
  | { readonly ok: true; readonly release: () => void }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

export interface AcquireUpdateLockOptions {
  readonly baseDirectory: string;
  readonly now: () => number;
  readonly staleMs: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
  }
  return undefined;
}

interface CreateAttempt {
  readonly outcome: "created" | "exists" | "error";
  readonly message?: string;
}

function tryCreateLock(lockPath: string, now: () => number): CreateAttempt {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return { outcome: "exists" };
    }
    return { outcome: "error", message: describe(error) };
  }
  try {
    writeSync(
      descriptor,
      JSON.stringify({ pid: process.pid, acquiredAt: now() }),
    );
  } catch (error) {
    // A lock we cannot annotate is unusable; remove it rather than leave a
    // corrupted lock behind. Close first: Windows will not unlink an open file.
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // best effort
    }
    return { outcome: "error", message: describe(error) };
  }
  closeSync(descriptor);
  return { outcome: "created" };
}

function readLockAgeMs(
  lockPath: string,
  now: () => number,
): number | undefined {
  try {
    const text = readFileSync(lockPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const acquiredAt = (parsed as { acquiredAt?: unknown }).acquiredAt;
      if (typeof acquiredAt === "number" && Number.isFinite(acquiredAt)) {
        return Math.max(0, now() - acquiredAt);
      }
    }
  } catch {
    // Fall through to the file mtime.
  }
  try {
    return Math.max(0, now() - statSync(lockPath).mtimeMs);
  } catch {
    return undefined;
  }
}

/**
 * Acquires the per-user update lock. On success the caller MUST invoke
 * `release()` on every terminal path.
 */
export function acquireUpdateLock(
  options: AcquireUpdateLockOptions,
): LockAcquisition {
  const paths = updateHomePaths(options.baseDirectory);
  try {
    mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.STORAGE_ERROR,
      message: `could not prepare the update home directory: ${describe(error)}`,
    };
  }

  const first = tryCreateLock(paths.lockPath, options.now);
  if (first.outcome === "created") {
    return { ok: true, release: createRelease(paths.lockPath) };
  }
  if (first.outcome === "error") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.STORAGE_ERROR,
      message: `could not create the update lock: ${first.message ?? "unknown error"}`,
    };
  }

  const ageMs = readLockAgeMs(paths.lockPath, options.now);
  if (ageMs !== undefined && ageMs >= options.staleMs) {
    // Reclaim the abandoned lock once, then retry the atomic create. A race
    // with another reclaimer simply returns lock-held to this process.
    try {
      unlinkSync(paths.lockPath);
    } catch {
      // Another process may have removed or replaced it first.
    }
    const second = tryCreateLock(paths.lockPath, options.now);
    if (second.outcome === "created") {
      return { ok: true, release: createRelease(paths.lockPath) };
    }
    if (second.outcome === "error") {
      return {
        ok: false,
        code: UPDATE_ERROR_CODES.STORAGE_ERROR,
        message: `could not create the update lock: ${second.message ?? "unknown error"}`,
      };
    }
  }

  return {
    ok: false,
    code: UPDATE_ERROR_CODES.LOCK_HELD,
    message: "another update attempt already holds the per-user update lock",
  };
}

function createRelease(lockPath: string): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process reclaimed it as stale; nothing to release.
    }
  };
}
