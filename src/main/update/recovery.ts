/**
 * Terminal-outcome bookkeeping for one update attempt.
 *
 * THE PROBLEM THIS SOLVES. The launcher hands a verified installer to NSIS
 * detached, with its standard streams ignored and its handle released, and
 * then quits so the installer can replace the running files. No process
 * therefore observes the installer's exit status: an `.onInit` abort (exit 2
 * for a bad handoff, exit 3 for the parent-wait timeout) and a mid-section
 * crash are indistinguishable from a silent relaunch. The only durable
 * receipts that exist are the atomic success markers the installer publishes
 * after a completed install, and a marker is written by definition only when
 * the install succeeded. So a marker-keyed recovery surface structurally
 * cannot fire on a FAILED install.
 *
 * THE SIGNAL. Before spawning, the launcher durably records the attempt:
 *
 *     <status dir>\attempt-<nonce>.json   {"nonce":"<nonce>","version":"<v>"}
 *
 * `<nonce>` is the same 128-bit nonce that names the pending directory and
 * that the installer is told to hand back on relaunch, and `<v>` is the target
 * version from the SIGNED manifest. Because the record is written before the
 * spawn, it exists no matter where the installer dies - before `.onInit`,
 * during the parent wait, or halfway through replacing files - so "an attempt
 * was recorded and no later launch has confirmed it" is a complete,
 * app-side-only description of a failed update.
 *
 * WHY A HEALTHY SUCCESS CANNOT PRODUCE A FALSE PROMPT. A completed install
 * always relaunches the freshly installed executable carrying the nonce, and
 * the installer publishes that nonce's marker before doing so. A nonce-
 * bearing launch is therefore resolved by the marker itself and can only
 * reach the repair branch when the marker is genuinely absent or invalid -
 * which is the classification this module already inherited. The unconfirmed
 * branch is reachable only on an ORDINARY (nonce-less) launch, i.e. one that no
 * installer relaunched, which cannot be the end of a healthy update.
 *
 * The one degraded variant is the installer include's own marker-publish
 * failure, which deliberately relaunches WITHOUT the nonce so a relaunch can
 * never claim an update it failed to record. There the install did in fact
 * land, so the recorded target version is compared against the running
 * version and an attempt that is already satisfied is consumed silently
 * instead of telling the user to repair something that is not broken.
 *
 * NO ROLLBACK. Nothing here can restore replaced files, and nothing here
 * claims to. The classification only decides whether to tell the user that an
 * installation cannot be confirmed and to offer the release page.
 *
 * SAFETY. The record is a recovery aid, never a trust input: no signature,
 * size, hash, path-to-execute, or identity decision reads it. The nonce is
 * re-validated by the same lowercase-hex pattern the pending directory uses
 * before it is ever joined into a path, a record whose payload disagrees with
 * its own file name is treated as unconfirmable, and the only directory this
 * module ever removes is the pending directory named by that same validated
 * nonce. Records are consumed on every terminal classification, so a single
 * failed attempt can produce at most one message.
 */
import fs from "node:fs";
import path from "node:path";
import { removePendingDirectory, updateHomePaths } from "./pending.ts";
import { verifyAndConsumeSuccessMarker } from "./relaunch.ts";
import { isValidUpdateNonce } from "./launch-arguments.ts";
import { compareSemver, parseSemver } from "./version.ts";

export const UPDATE_ATTEMPT_RECORD_PREFIX = "attempt-";
export const UPDATE_ATTEMPT_RECORD_EXTENSION = ".json";

/**
 * A file name is the ONLY way a recorded attempt is discovered, so the name
 * itself is the nonce validator: anything that is not exactly
 * `attempt-<32 lowercase hex>.json` is not an attempt record, and the captured
 * group is the only value ever joined into a path.
 */
const ATTEMPT_RECORD_NAME_PATTERN = /^attempt-([0-9a-f]{32})\.json$/;

/** Reason the ordinary-launch branch classifies a recorded attempt. */
export type UnconfirmedUpdateRepairReason = "unconfirmed";

export interface RecordUpdateAttemptOptions {
  readonly statusDirectory: string;
  /** The attempt nonce; must be the 32 lowercase hex value the domain uses. */
  readonly nonce: string;
  /** Target version from the signed manifest for this attempt. */
  readonly version: string;
}

export type UpdateAttemptRecordResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAttemptNonce(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function attemptRecordPath(statusDirectory: string, nonce: string): string {
  return path.join(
    statusDirectory,
    `${UPDATE_ATTEMPT_RECORD_PREFIX}${nonce}${UPDATE_ATTEMPT_RECORD_EXTENSION}`,
  );
}

/**
 * Durably records one handed-off attempt. Called by the launcher immediately
 * before the spawn, so its presence on a later launch is the only evidence
 * that an update was ever started. Exclusively created (`wx`): a nonce can
 * never be reused, so an existing record means the write lost a race and is
 * reported instead of silently overwriting another attempt's record.
 */
export function recordUpdateAttempt(
  options: RecordUpdateAttemptOptions,
): UpdateAttemptRecordResult {
  if (!isAttemptNonce(options.nonce)) {
    return {
      ok: false,
      message: "the update attempt nonce must be 32 lowercase hex characters",
    };
  }
  try {
    fs.mkdirSync(options.statusDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      attemptRecordPath(options.statusDirectory, options.nonce),
      JSON.stringify({ nonce: options.nonce, version: options.version }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `could not record the update attempt: ${describe(error)}`,
    };
  }
}

/**
 * Removes one attempt record. The launcher calls this when the verified
 * installer never actually ran, so no record of a non-attempt can be left to
 * make a later launch claim a failure that never happened.
 */
export function discardUpdateAttemptRecord(
  statusDirectory: string,
  nonce: string,
): boolean {
  if (!isAttemptNonce(nonce)) {
    return false;
  }
  try {
    fs.unlinkSync(attemptRecordPath(statusDirectory, nonce));
    return true;
  } catch {
    // A record that cannot be deleted still verified; cleanup is best effort.
    return false;
  }
}

interface RecordedAttempt {
  readonly nonce: string;
  /** Recorded target version, or null when the payload is not trustworthy. */
  readonly version: string | null;
}

function readRecordedVersion(recordPath: string, nonce: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(recordPath, "utf8");
  } catch {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as { nonce?: unknown; version?: unknown };
  // The file name and the payload must agree; a record that disagrees with
  // its own name is not a record this module will act on.
  if (record.nonce !== nonce) {
    return null;
  }
  return typeof record.version === "string" ? record.version : null;
}

function readRecordedAttempts(statusDirectory: string): RecordedAttempt[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(statusDirectory);
  } catch {
    // No status directory means no attempt was ever recorded.
    return [];
  }
  const attempts: RecordedAttempt[] = [];
  for (const entry of entries) {
    const match = ATTEMPT_RECORD_NAME_PATTERN.exec(entry);
    if (match === null || match[1] === undefined) {
      continue;
    }
    const nonce = match[1];
    attempts.push({
      nonce,
      version: readRecordedVersion(path.join(statusDirectory, entry), nonce),
    });
  }
  // readdir order is filesystem-defined; sort so one launch with several
  // recorded attempts classifies them in a fixed, reproducible order.
  attempts.sort((left, right) => (left.nonce < right.nonce ? -1 : 1));
  return attempts;
}

/**
 * True when the running executable is already at or past the recorded target.
 * Fail-closed: an unparsable version on either side is NOT satisfaction, so an
 * unconfirmable attempt still reaches the user as a repair.
 */
function isSatisfiedByVersion(
  currentVersion: string,
  recordedVersion: string,
): boolean {
  const current = parseSemver(currentVersion);
  const target = parseSemver(recordedVersion);
  if (current === undefined || target === undefined) {
    return false;
  }
  return compareSemver(current, target) >= 0;
}

export interface UpdateRecoveryOptions {
  /** Directory holding the success markers and the attempt records. */
  readonly statusDirectory: string;
  /** Base directory of the update domain (the parent of the pending root). */
  readonly updateBaseDirectory: string;
  /** The sanctioned launch nonce, or null for an ordinary launch. */
  readonly launchNonce: string | null;
  /** Version of the running executable. */
  readonly currentVersion: string;
}

export type UpdateRecoveryClassification =
  | { readonly kind: "none" }
  | { readonly kind: "confirmed"; readonly nonce: string }
  | {
      readonly kind: "satisfied";
      readonly nonce: string;
      readonly version: string;
    }
  | {
      readonly kind: "repair";
      readonly reason: "missing" | "invalid" | UnconfirmedUpdateRepairReason;
      /** Every attempt this classification consumed and could not confirm. */
      readonly nonces: readonly string[];
    };

/**
 * The single entry point the composition root calls once per launch, before
 * any window exists. It resolves the previous attempt (if any), reclaims the
 * pending installer for every attempt whose outcome is now terminal, and
 * reports what - if anything - the user must be told.
 *
 * Total: every filesystem error degrades to a classification. An empty
 * status directory is the ordinary "no update was ever attempted here" case
 * and resolves to `none` without touching the pending tree.
 */
export function classifyUpdateRecovery(
  options: UpdateRecoveryOptions,
): UpdateRecoveryClassification {
  const pendingRoot = updateHomePaths(options.updateBaseDirectory).pendingRoot;

  if (options.launchNonce !== null) {
    if (!isValidUpdateNonce(options.launchNonce)) {
      return { kind: "none" };
    }
    // A relaunch the installer performed: the marker for THIS nonce is the
    // authoritative receipt, exactly as before. Either way the attempt is
    // terminal now - the installer has finished reading the pending file -
    // so its record and its installer copy are both reclaimed.
    const verification = verifyAndConsumeSuccessMarker({
      statusDirectory: options.statusDirectory,
      nonce: options.launchNonce,
    });
    discardUpdateAttemptRecord(options.statusDirectory, options.launchNonce);
    removePendingDirectory(path.join(pendingRoot, options.launchNonce));
    if (verification.ok) {
      return { kind: "confirmed", nonce: options.launchNonce };
    }
    return {
      kind: "repair",
      reason: verification.reason,
      nonces: [options.launchNonce],
    };
  }

  const attempts = readRecordedAttempts(options.statusDirectory);
  if (attempts.length === 0) {
    return { kind: "none" };
  }

  const unconfirmed: string[] = [];
  let confirmed: string | null = null;
  let satisfied: RecordedAttempt | null = null;
  for (const attempt of attempts) {
    // The recorded attempt is terminal on this launch whatever the outcome,
    // so the record is consumed and the pending copy reclaimed. Removal is
    // best effort: on Windows a copy still executing by a second, manually
    // launched instance cannot be deleted, and that bounded residue is inert.
    discardUpdateAttemptRecord(options.statusDirectory, attempt.nonce);
    removePendingDirectory(path.join(pendingRoot, attempt.nonce));

    if (
      verifyAndConsumeSuccessMarker({
        statusDirectory: options.statusDirectory,
        nonce: attempt.nonce,
      }).ok
    ) {
      // The installer published its receipt but never relaunched the app
      // with the nonce; the install did complete, so nothing is broken.
      confirmed ??= attempt.nonce;
      continue;
    }
    if (
      attempt.version !== null &&
      isSatisfiedByVersion(options.currentVersion, attempt.version)
    ) {
      satisfied ??= attempt;
      continue;
    }
    unconfirmed.push(attempt.nonce);
  }

  if (unconfirmed.length > 0) {
    return { kind: "repair", reason: "unconfirmed", nonces: unconfirmed };
  }
  if (confirmed !== null) {
    return { kind: "confirmed", nonce: confirmed };
  }
  if (satisfied !== null) {
    return {
      kind: "satisfied",
      nonce: satisfied.nonce,
      version: satisfied.version ?? "",
    };
  }
  return { kind: "none" };
}
