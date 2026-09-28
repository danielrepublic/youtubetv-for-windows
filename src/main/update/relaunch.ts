/**
 * Post-install relaunch verification (the "no-rollback recovery" half of the
 * update contract).
 *
 * After a silent NSIS update the installer relaunches the freshly installed
 * executable with `--update-nonce=<nonce>` and writes an atomic marker
 *
 *     <status dir>\success-<nonce>.json
 *
 * before the relaunch. `build/nsis.include` performs the write as
 * temp-file + `Rename`, so the marker is either fully present or absent —
 * never half-written. The relaunched bootstrap calls
 * `verifyAndConsumeSuccessMarker` exactly once:
 *
 *   - marker present and its `nonce` equals the launch nonce  -> success.
 *     The marker is CONSUMED (deleted): it is a one-shot receipt, and a
 *     second launch must not see a stale success.
 *   - marker missing or invalid -> the install cannot be proven. The caller
 *     shows the bilingual repair/manual-download guidance and continues
 *     launching the installed version. There is deliberately NO rollback:
 *     the previous installer bytes were replaced, and the documented
 *     recovery is a manual download from the GitHub Releases page.
 *
 * An invalid marker is deleted as well. It can never become valid by
 * waiting, and leaving it in place would repeat the identical guidance on
 * every launch until a human cleaned the directory manually.
 *
 * The nonce is re-validated here before it is ever joined into a path, so a
 * hostile argument value can never traverse out of the status directory.
 */
import fs from "node:fs";
import path from "node:path";
import { isValidUpdateNonce } from "./launch-arguments.ts";

export const UPDATE_SUCCESS_MARKER_PREFIX = "success-";
export const UPDATE_SUCCESS_MARKER_EXTENSION = ".json";

export type RelaunchMarkerFailureReason = "missing" | "invalid";

export type RelaunchMarkerVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RelaunchMarkerFailureReason };

/** Exact marker path for a nonce; the caller must have validated the nonce. */
export function successMarkerPath(
  statusDirectory: string,
  nonce: string,
): string {
  return path.join(
    statusDirectory,
    `${UPDATE_SUCCESS_MARKER_PREFIX}${nonce}${UPDATE_SUCCESS_MARKER_EXTENSION}`,
  );
}

function unlinkQuietly(targetPath: string): void {
  try {
    fs.unlinkSync(targetPath);
  } catch {
    // A marker that cannot be deleted still verified; cleanup is best effort.
  }
}

/**
 * Verifies the success marker for `nonce` and consumes it. The classification
 * is total: a missing file, unreadable bytes, malformed JSON, a wrong shape,
 * or a nonce mismatch all report `{ ok: false, reason }` instead of throwing.
 */
export function verifyAndConsumeSuccessMarker(options: {
  readonly statusDirectory: string;
  readonly nonce: string;
}): RelaunchMarkerVerification {
  if (!isValidUpdateNonce(options.nonce)) {
    return { ok: false, reason: "invalid" };
  }
  const markerPath = successMarkerPath(options.statusDirectory, options.nonce);

  let text: string;
  try {
    text = fs.readFileSync(markerPath, "utf8");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: "invalid" };
  }

  let markerNonce: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    markerNonce =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { nonce?: unknown }).nonce
        : undefined;
  } catch {
    markerNonce = undefined;
  }

  if (markerNonce !== options.nonce) {
    unlinkQuietly(markerPath);
    return { ok: false, reason: "invalid" };
  }
  unlinkQuietly(markerPath);
  return { ok: true };
}
