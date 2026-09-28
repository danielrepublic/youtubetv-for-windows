/**
 * The pre-window update stage: the single place where the application
 * decides whether to hand off to the NSIS installer or launch the installed
 * version.
 *
 * Contract (plan lines 56-58, todo 6):
 *
 *   check -> verify -> download -> verify -> re-verify from the pending path
 *   -> spawn NSIS detached -> quit; the installed version launches on every
 *   other outcome.
 *
 * The stage is deliberately Electron-free: `app`, windows, dialogs, the
 * clock, the transport, the spawner and the quit call are all injected by the
 * composition root (`src/main/index.ts`) or by a test. That keeps the whole
 * decision machine executable with fake seams, and it keeps the ONE
 * BrowserWindow ordering guarantee testable (see `startHost` in `app.ts`:
 * the stage resolves before `createWindow` is ever called, and a `quit`
 * decision returns without creating a window).
 *
 * Outcome classification (plan 54/56):
 *   - `up-to-date`   -> launch the installed version silently.
 *   - `skipped`      -> launch the installed version silently (rate limit,
 *                       timeout, offline, upstream release problem, or lock
 *                       held by a concurrent attempt).
 *   - `failed`       -> show the bilingual pre-install guidance, then launch
 *                       the installed version.
 *   - `update-ready` -> RE-VERIFY the pending installer from the exact path,
 *                       spawn it detached with the silent flag, the parent
 *                       PID and the nonce, then request the quit that skips
 *                       window creation entirely.
 *
 * The whole check is wrapped in ONE bounded overall budget. Expiry is a
 * classified skip: the installed version launches, and a pending directory
 * created after the deadline by the abandoned in-flight check is removed so
 * it can never be spawned later.
 *
 * Locking is owned entirely by `checkForUpdate` (the per-user atomic lock is
 * acquired before discovery and released on every terminal path). This module
 * adds nothing that could bypass it.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  showUpdateGuidance,
  updateFailureDialog,
  type DialogPresenter,
} from "../dialogs.ts";
import { resolveUpdateDirectoryConvention } from "../profile-path.ts";
import { checkForUpdate, type UpdateCheckResult } from "./check-for-update.ts";
import type { EtagCache } from "./discovery.ts";
import type { UpdateErrorCode } from "./error-codes.ts";
import type { Transport } from "./http-download.ts";
import { verifyInstallerFile } from "./installer.ts";
import type { UpdateKeyring } from "./keyring.ts";
import { resolveUpdateLimits, type UpdateLimits } from "./limits.ts";
import { removePendingDirectory } from "./pending.ts";

/**
 * One budget for the complete stage (discovery + manifest/signature +
 * installer download + both verifications). Chosen so a 512 MiB installer
 * still fits at a modest ~3 MiB/s while startup can never wait forever; the
 * value is overridable in tests and by a future policy change.
 */
export const DEFAULT_PREWINDOW_TIMEOUT_MS = 180_000;

export type PreWindowDecision =
  | {
      readonly action: "launch";
      readonly reason: "up-to-date" | "skipped" | "failed" | "timeout";
    }
  | { readonly action: "quit"; readonly reason: "update-ready" };

export interface InstallerSpawnOptions {
  readonly detached: true;
  readonly windowsHide: true;
  readonly stdio: "ignore";
}

/** Options for the exact detached handoff; identical in every call site. */
export const INSTALLER_SPAWN_OPTIONS: InstallerSpawnOptions = Object.freeze({
  detached: true,
  windowsHide: true,
  stdio: "ignore",
});

export type InstallerSpawnOutcome =
  | {
      readonly ok: true;
      /** Releases the child handle so the installer survives the quit. */
      readonly unref: () => void;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Injected spawn seam. Production passes `spawnDetachedInstaller`; tests
 * assert the exact arguments/options and drive both the success and the
 * failure branch synchronously.
 */
export type InstallerSpawner = (
  installerPath: string,
  argumentsList: readonly string[],
  options: InstallerSpawnOptions,
) => InstallerSpawnOutcome;

/** The diagnostics event names this stage may report. */
export type UpdateStageEvent =
  | "update-check-completed"
  | "update-check-timeout"
  | "update-spawned"
  | "update-spawn-failed";

export interface UpdateStageReport {
  readonly event: UpdateStageEvent;
  /** Classified domain code; only real `UPDATE_ERROR_CODES` values. */
  readonly updateCode?: UpdateErrorCode;
}

export interface PreWindowStageOptions {
  /**
   * Activated profile directory. The update directories are its siblings:
   * `<parent>\updates` (pending + lock) and `<parent>\update-status`
   * (success markers), per the profile-path convention.
   */
  readonly profileDirectory: string;
  /** Injected fetch-like transport; production passes `globalThis.fetch`. */
  readonly transport: Transport;
  readonly keyring: UpdateKeyring;
  /**
   * Version compared against the manifest. The Electron main process IS the
   * launcher stage, so one value serves freshness and both minimum-version
   * gates.
   */
  readonly version: string;
  readonly etagCache: EtagCache;
  readonly now: () => number;
  readonly limits?: Partial<UpdateLimits>;
  /** Bounded budget for the complete stage. */
  readonly overallTimeoutMs?: number;
  /** PID handed to the installer as `--update-parent-pid`. */
  readonly processId: number;
  readonly spawnInstaller: InstallerSpawner;
  /** Called exactly once on update-ready, before the decision returns. */
  readonly requestQuit: () => void;
  readonly presenter: DialogPresenter;
  /** Opens the release page when the guidance dialog's first button wins. */
  readonly openDownloadPage: () => void;
  readonly report: (record: UpdateStageReport) => void;
}

/** Exact installer command line; the NSIS include parses both flags. */
export function installerArguments(
  processId: number,
  nonce: string,
): readonly string[] {
  return ["/S", `--update-parent-pid=${processId}`, `--update-nonce=${nonce}`];
}

type RaceOutcome =
  | { readonly kind: "completed"; readonly result: UpdateCheckResult }
  | { readonly kind: "timeout" };

function raceWithTimeout(
  check: Promise<UpdateCheckResult>,
  timeoutMs: number,
): Promise<RaceOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          resolve({ kind: "timeout" });
        }
      },
      Math.max(1, timeoutMs),
    );
    check.then(
      (result) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "completed", result });
        }
      },
      () => {
        // `checkForUpdate` is total and never rejects; this branch exists so
        // a future defect degrades to the timeout path instead of an
        // unhandled rejection.
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ kind: "timeout" });
        }
      },
    );
  });
}

async function showFailureGuidance(
  options: PreWindowStageOptions,
  kind: "download-or-verify-failed" | "installer-launch-failed",
): Promise<void> {
  await showUpdateGuidance(
    options.presenter,
    updateFailureDialog(kind),
    options.openDownloadPage,
  );
}

/**
 * Runs the update stage exactly once. Resolves a decision; never throws for
 * any update-domain outcome (the presenter or spawner could in principle
 * throw, and those propagate as programming errors like every other wiring
 * seam in this repository).
 */
export async function runPreWindowStage(
  options: PreWindowStageOptions,
): Promise<PreWindowDecision> {
  const limits = resolveUpdateLimits(options.limits);
  const directories = resolveUpdateDirectoryConvention(
    options.profileDirectory,
  );

  const check = checkForUpdate({
    transport: options.transport,
    currentVersion: options.version,
    appVersion: options.version,
    bootstrapVersion: options.version,
    keyring: options.keyring,
    baseDirectory: directories.updateBaseDirectory,
    etagCache: options.etagCache,
    now: options.now,
    limits,
  });

  const outcome = await raceWithTimeout(
    check,
    options.overallTimeoutMs ?? DEFAULT_PREWINDOW_TIMEOUT_MS,
  );
  if (outcome.kind === "timeout") {
    options.report({ event: "update-check-timeout" });
    // The abandoned check cannot be cancelled (the domain has no abort seam
    // for the whole orchestration), so its late terminal state is reclaimed:
    // a pending directory produced after the deadline is removed and can
    // never be spawned by this launch.
    void check.then((late) => {
      if (late.kind === "update-ready") {
        removePendingDirectory(path.dirname(late.installerPath));
      }
    });
    return { action: "launch", reason: "timeout" };
  }

  const result = outcome.result;
  switch (result.kind) {
    case "up-to-date": {
      options.report({ event: "update-check-completed" });
      return { action: "launch", reason: "up-to-date" };
    }
    case "skipped": {
      options.report({
        event: "update-check-completed",
        updateCode: result.code,
      });
      return { action: "launch", reason: "skipped" };
    }
    case "failed": {
      options.report({
        event: "update-check-completed",
        updateCode: result.code,
      });
      await showFailureGuidance(options, "download-or-verify-failed");
      return { action: "launch", reason: "failed" };
    }
    case "update-ready": {
      // Re-verify the EXACT pending path immediately before execution. This
      // closes the window between the download decision and the spawn in
      // which a swapped, truncated, or replaced file would otherwise run.
      const verification = await verifyInstallerFile({
        path: result.installerPath,
        expectedSize: result.manifest.size,
        expectedSha256: result.manifest.sha256,
        maxBytes: limits.maxInstallerBytes,
      });
      if (!verification.ok) {
        removePendingDirectory(path.dirname(result.installerPath));
        options.report({
          event: "update-check-completed",
          updateCode: verification.code,
        });
        await showFailureGuidance(options, "download-or-verify-failed");
        return { action: "launch", reason: "failed" };
      }

      const spawned = options.spawnInstaller(
        result.installerPath,
        installerArguments(options.processId, result.nonce),
        INSTALLER_SPAWN_OPTIONS,
      );
      if (!spawned.ok) {
        // The installer never ran, so the pending file is ours to remove.
        // After a SUCCESSFUL spawn the file must NOT be deleted: the
        // installer executes from that exact path.
        removePendingDirectory(path.dirname(result.installerPath));
        options.report({ event: "update-spawn-failed" });
        await showFailureGuidance(options, "installer-launch-failed");
        return { action: "launch", reason: "failed" };
      }

      spawned.unref();
      options.report({ event: "update-spawned" });
      options.requestQuit();
      return { action: "quit", reason: "update-ready" };
    }
  }
}

/**
 * Production spawner. `child.pid` is set synchronously only when the process
 * was actually created, so the common CreateProcess failure (missing or
 * non-executable file, access denied) is classified as a failure here instead
 * of surfacing as an asynchronous `error` event after the app already quit.
 * The `error` listener is still attached: an asynchronous failure must never
 * crash the quitting process.
 */
export function spawnDetachedInstaller(
  installerPath: string,
  argumentsList: readonly string[],
  options: InstallerSpawnOptions,
): InstallerSpawnOutcome {
  try {
    const child = spawn(installerPath, [...argumentsList], { ...options });
    child.on("error", () => {
      // Best effort: the decision was already made and the process is
      // quitting; there is no fallback left to take.
    });
    if (child.pid === undefined) {
      return {
        ok: false,
        message: "the installer process could not be created",
      };
    }
    return { ok: true, unref: () => child.unref() };
  } catch (error) {
    return {
      ok: false,
      message: `could not spawn the verified installer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
