/**
 * The pure update-check orchestrator.
 *
 * This module owns the whole trust decision and nothing process-related: it
 * never creates an Electron window, never spawns NSIS, and never touches the
 * real profile path unless a caller injects it. Todo 6 wires the result into
 * startup.
 *
 * Sequence:
 *
 *   1. acquire the per-user lock (a concurrent attempt returns `lock-held`
 *      without touching any state),
 *   2. discover the latest release (ETag-cached, classified skips),
 *   3. download the exact manifest + signature assets under the redirect and
 *      size policy,
 *   4. strict-parse the manifest, verify the detached Ed25519 signature over
 *      the canonical bytes, then apply version/binding policy,
 *   5. create a nonce pending directory and stream the installer while
 *      verifying size and SHA-256 against the signed manifest,
 *   6. return `update-ready` with the verified local path; every other
 *      terminal path removes the pending directory and releases the lock.
 *
 * `checkForUpdate` is total: it never rejects. A malformed response, an
 * unreachable network, or an internal bug all resolve to a classified result
 * so the installed application can still launch (plan line 54/155).
 */
import {
  UPDATE_ERROR_CODES,
  isSkipCode,
  type UpdateErrorCode,
} from "./error-codes.ts";
import {
  discoverLatestRelease,
  findManifestAsset,
  findSignatureAsset,
  type EtagCache,
} from "./discovery.ts";
import {
  openDownloadStream,
  readBodyBytes,
  type Transport,
} from "./http-download.ts";
import { downloadVerifiedInstaller } from "./installer.ts";
import type { UpdateKeyring } from "./keyring.ts";
import { acquireUpdateLock } from "./lock.ts";
import { resolveUpdateLimits, type UpdateLimits } from "./limits.ts";
import { parseUpdateManifest, type UpdateManifest } from "./manifest-schema.ts";
import { createPendingDirectory, removePendingDirectory } from "./pending.ts";
import { evaluateUpdatePolicy } from "./policy.ts";
import { verifyManifestSignature } from "./signature.ts";

/**
 * The discriminated union consumed by todo 6.
 *
 *   - `up-to-date`   — nothing to do; launch the installed version.
 *   - `skipped`      — the check could not complete against a trustworthy
 *                      candidate; launch the installed version.
 *   - `update-ready` — a fully verified installer is on disk at
 *                      `installerPath` (`nonce` names its pending directory).
 *                      The lock is already released; the caller owns the
 *                      pending directory from here.
 *   - `failed`       — a candidate existed and was rejected; launch the
 *                      installed version and optionally show guidance.
 */
export type UpdateCheckResult =
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "skipped";
      readonly code: UpdateErrorCode;
      readonly message: string;
    }
  | {
      readonly kind: "update-ready";
      readonly manifest: UpdateManifest;
      readonly installerPath: string;
      readonly nonce: string;
    }
  | {
      readonly kind: "failed";
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

export interface CheckForUpdateOptions {
  /** Injected `fetch`-like transport; production passes `globalThis.fetch`. */
  readonly transport: Transport;
  /** Installed app version used for the freshness comparison. */
  readonly currentVersion: string;
  /** Running app version used for the `minAppVersion` gate. */
  readonly appVersion: string;
  /** Running bootstrap version used for the `minBootstrapVersion` gate. */
  readonly bootstrapVersion: string;
  /** Embedded public keyring (production or test). */
  readonly keyring: UpdateKeyring;
  /** Injectable base directory for lock + pending storage. */
  readonly baseDirectory: string;
  /** Injectable ETag cache. */
  readonly etagCache: EtagCache;
  /** Injected clock in epoch milliseconds. */
  readonly now: () => number;
  /** Optional budget overrides; tests use tiny values. */
  readonly limits?: Partial<UpdateLimits>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classify(code: UpdateErrorCode, message: string): UpdateCheckResult {
  return isSkipCode(code)
    ? { kind: "skipped", code, message }
    : { kind: "failed", code, message };
}

function failed(code: UpdateErrorCode, message: string): UpdateCheckResult {
  return { kind: "failed", code, message };
}

type AssetBytes =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

async function fetchAssetText(
  transport: Transport,
  url: string,
  limits: UpdateLimits,
): Promise<AssetBytes> {
  const outcome = await openDownloadStream(transport, url, {
    headers: { accept: "application/octet-stream" },
    maxBytes: limits.maxManifestBytes,
    limits,
  });
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  const body = await readBodyBytes(outcome.response, limits.maxManifestBytes);
  if (!body.ok) {
    return { ok: false, code: body.code, message: body.message };
  }
  return { ok: true, text: body.text };
}

async function runUpdateCheck(
  options: CheckForUpdateOptions,
  limits: UpdateLimits,
  registerPendingDirectory: (directory: string, nonce: string) => void,
): Promise<UpdateCheckResult> {
  const discovery = await discoverLatestRelease({
    transport: options.transport,
    etagCache: options.etagCache,
    limits,
  });
  if (!discovery.ok) {
    return classify(discovery.code, discovery.message);
  }
  const release = discovery.release;

  const manifestAsset = findManifestAsset(release);
  if (!manifestAsset.ok) {
    return classify(manifestAsset.code, manifestAsset.message);
  }
  const signatureAsset = findSignatureAsset(release);
  if (!signatureAsset.ok) {
    return classify(signatureAsset.code, signatureAsset.message);
  }

  const manifestBytes = await fetchAssetText(
    options.transport,
    manifestAsset.asset.url,
    limits,
  );
  if (!manifestBytes.ok) {
    return classify(manifestBytes.code, manifestBytes.message);
  }
  const parsedManifest = parseUpdateManifest(manifestBytes.text);
  if (!parsedManifest.ok) {
    return failed(parsedManifest.code, parsedManifest.message);
  }
  const manifest = parsedManifest.manifest;

  const signatureBytes = await fetchAssetText(
    options.transport,
    signatureAsset.asset.url,
    limits,
  );
  if (!signatureBytes.ok) {
    return classify(signatureBytes.code, signatureBytes.message);
  }

  // The signature is verified before any policy decision trusts a field.
  const verification = verifyManifestSignature({
    keyring: options.keyring,
    manifest,
    signatureBase64: signatureBytes.text,
  });
  if (!verification.ok) {
    return failed(verification.code, verification.message);
  }

  const policy = evaluateUpdatePolicy({
    manifest,
    release,
    currentVersion: options.currentVersion,
    appVersion: options.appVersion,
    bootstrapVersion: options.bootstrapVersion,
  });
  if (!policy.ok) {
    if (policy.kind === "up-to-date") {
      return { kind: "up-to-date" };
    }
    return failed(policy.code, policy.message);
  }

  const pending = createPendingDirectory(options.baseDirectory);
  if (!pending.ok) {
    return failed(pending.code, pending.message);
  }
  registerPendingDirectory(pending.directory, pending.nonce);

  const installer = await downloadVerifiedInstaller({
    transport: options.transport,
    assetUrl: policy.installerAssetUrl,
    assetName: manifest.installerAssetName,
    expectedSize: manifest.size,
    expectedSha256: manifest.sha256,
    directory: pending.directory,
    limits,
  });
  if (!installer.ok) {
    return classify(installer.code, installer.message);
  }

  return {
    kind: "update-ready",
    manifest,
    installerPath: installer.installer.path,
    nonce: pending.nonce,
  };
}

/** Runs one complete, bounded, fail-closed update check. Never throws. */
export async function checkForUpdate(
  options: CheckForUpdateOptions,
): Promise<UpdateCheckResult> {
  const limits = resolveUpdateLimits(options.limits);
  const lock = acquireUpdateLock({
    baseDirectory: options.baseDirectory,
    now: options.now,
    staleMs: limits.lockStaleMs,
  });
  if (!lock.ok) {
    return lock.code === UPDATE_ERROR_CODES.LOCK_HELD
      ? { kind: "skipped", code: lock.code, message: lock.message }
      : failed(lock.code, lock.message);
  }

  let pendingDirectory: string | undefined;
  try {
    const result = await runUpdateCheck(options, limits, (directory) => {
      pendingDirectory = directory;
    });
    if (result.kind !== "update-ready" && pendingDirectory !== undefined) {
      removePendingDirectory(pendingDirectory);
    }
    return result;
  } catch (error) {
    if (pendingDirectory !== undefined) {
      removePendingDirectory(pendingDirectory);
    }
    return failed(
      UPDATE_ERROR_CODES.INTERNAL_ERROR,
      `the update check failed unexpectedly: ${describe(error)}`,
    );
  } finally {
    lock.release();
  }
}
