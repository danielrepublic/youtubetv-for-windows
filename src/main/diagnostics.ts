// Opt-in lifecycle diagnostics for the host.
//
// PURPOSE: while a maintainer certifies the live Google sign-in flow
// (docs/live-sign-in-certification.md) the build can record a strictly
// non-secret life-cycle trace: window creation, committed navigation ORIGINS
// (never full URLs), load finish/failure codes, auth-child open/close, and
// app ready/quit. Nothing else is ever written.
//
// OPT-IN (single read point): diagnostics are OFF by default. They turn on
// only when the documented sentinel file exists:
//
//   %PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\ENABLED
//
// createProfileDiagnostics performs exactly ONE filesystem read of that
// marker (`existsSync`) and returns null when it is absent. The todo 2/3
// no-override suites ban runtime override reads (CLI arguments, environment
// variables, Chromium switches) in production source, and weakening those
// guards to add a flag/env switch was explicitly out of scope, so the
// sentinel file is the sanctioned opt-in. When the factory returns null the
// caller wires nothing: navigation, UA, popup and security behavior are
// byte-identical to a non-diagnostic build.
//
// SINK PATH (the uninstaller removes the whole
// %PROGRAMDATA%\youtubetv-for-windows machine tree, which contains this
// directory and every user's profile + userdata directories):
//
//   %PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\
//       diagnostic-<YYYYMMDDThhmmssSSSZ>-p<pid>-<instance>.jsonl
//
// The directory is created lazily on the first record; every filesystem
// failure is swallowed and counted so diagnostics can never crash the host.
//
// REDACTION: every record passes through a pure sanitizer before it is
// serialized. Fields are strictly allowlisted ({ ts, event, origin?,
// errorCode?, windowKind? }); unknown keys are dropped and
// unknown events are rejected outright. `ts` always comes from the trusted
// clock, never from the caller. Origins are normalised with
// `new URL(...).origin`, which strips credentials, paths, query strings and
// fragments by construction. A secret-shape detector additionally refuses any string that
// looks like a JWT, a bearer token, a cookie, an authorization header, a
// `token=` parameter, or a long base64/hex blob.

import fs from "node:fs";
import path from "node:path";

export const DIAGNOSTICS_SUBDIRECTORY_NAME = "diagnostics";
export const DIAGNOSTICS_ENABLE_MARKER_NAME = "ENABLED";
export const DIAGNOSTICS_FILE_PREFIX = "diagnostic-";
export const DIAGNOSTICS_FILE_EXTENSION = ".jsonl";

// The complete emitted schema. Anything not in this list can never appear in
// a diagnostics line.
export const ALLOWED_DIAGNOSTIC_FIELDS = [
  "ts",
  "event",
  "origin",
  "errorCode",
  "windowKind",
] as const;
export type AllowedDiagnosticField = (typeof ALLOWED_DIAGNOSTIC_FIELDS)[number];

// The complete event vocabulary is lifecycle plus numeric codes. No event
// carries free text.
export const DIAGNOSTIC_EVENTS = [
  "app-ready",
  "app-quit",
  "window-created",
  "navigation-committed",
  "load-finished",
  "load-failed",
  "auth-window-opened",
  "auth-window-closed",
] as const;
export type DiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number];

export const DIAGNOSTIC_WINDOW_KINDS = ["main", "auth"] as const;
export type DiagnosticWindowKind = (typeof DIAGNOSTIC_WINDOW_KINDS)[number];

// What call sites hand to a recorder. Values are `unknown` on purpose: the
// sanitizer re-validates every field no matter how the caller typed it.
export interface DiagnosticInput {
  event: DiagnosticEvent | string;
  origin?: string;
  errorCode?: number;
  windowKind?: DiagnosticWindowKind | string;
}

export interface SanitizedDiagnosticRecord {
  ts: number;
  event: DiagnosticEvent;
  origin?: string;
  errorCode?: number;
  windowKind?: DiagnosticWindowKind;
}

// The narrow surface policies depend on, so production passes the file sink
// and tests pass an array-recording fake without any filesystem access.
export interface DiagnosticRecorder {
  record(input: DiagnosticInput): void;
}

const SECRET_MARKERS: readonly RegExp[] = [
  /token=/i,
  /sapisid/i,
  /\bsid=/i,
  /\bbearer\s/i,
  /authorization/i,
  /cookie/i,
  /\beyJ[A-Za-z0-9_-]{2,}\./,
];

// Long hex (raw hashes/session ids) and long base64/base64url runs. Both are
// fail-closed: a legitimate value that happens to look like a blob is
// dropped rather than logged.
const LONG_HEX = /(^|[^0-9a-fA-F])[0-9a-fA-F]{32,}([^0-9a-fA-F]|$)/;
const LONG_BASE64 = /[A-Za-z0-9+/]{40,}={0,2}/;
const LONG_BASE64URL = /[A-Za-z0-9_-]{48,}/;

export function looksLikeSecret(value: string): boolean {
  if (SECRET_MARKERS.some((pattern) => pattern.test(value))) {
    return true;
  }
  return (
    LONG_HEX.test(value) ||
    LONG_BASE64.test(value) ||
    LONG_BASE64URL.test(value)
  );
}

// Reduces any navigation URL to scheme://host[:port]. Query strings,
// fragments, paths and credentials can never survive this call; malformed
// input, opaque origins (`javascript:`, `data:`, `file:`, custom schemes)
// and secret-shaped results are dropped.
export function sanitizeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const origin = parsed.origin;
  if (origin === "null" || origin.length === 0) {
    return undefined;
  }
  if (looksLikeSecret(origin)) {
    return undefined;
  }
  return origin;
}

function sanitizeErrorCode(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < -2147483648 || value > 2147483647) {
    return undefined;
  }
  return value;
}

function sanitizeWindowKind(value: unknown): DiagnosticWindowKind | undefined {
  if (value === "main" || value === "auth") {
    return value;
  }
  return undefined;
}

export function isDiagnosticEvent(value: string): value is DiagnosticEvent {
  return (DIAGNOSTIC_EVENTS as readonly string[]).includes(value);
}

// Pure sanitizer. Returns the exact record that may be serialized, or null
// when the input cannot be reduced to an allowlisted one. Unknown keys are
// never copied; `input.ts` is deliberately never read (the trusted clock
// wins); a non-allowlisted `event` rejects the whole record.
export function sanitizeDiagnosticRecord(
  input: unknown,
  now: number,
): SanitizedDiagnosticRecord | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    return null;
  }
  const source = input as Record<string, unknown>;
  const event = source["event"];
  if (typeof event !== "string" || !isDiagnosticEvent(event)) {
    return null;
  }
  const record: SanitizedDiagnosticRecord = { ts: now, event };
  const origin = sanitizeOrigin(source["origin"]);
  if (origin !== undefined) {
    record.origin = origin;
  }
  const errorCode = sanitizeErrorCode(source["errorCode"]);
  if (errorCode !== undefined) {
    record.errorCode = errorCode;
  }
  const windowKind = sanitizeWindowKind(source["windowKind"]);
  if (windowKind !== undefined) {
    record.windowKind = windowKind;
  }
  return record;
}

// One JSON Lines record (no trailing newline), or null when rejected.
export function formatDiagnosticLine(
  input: unknown,
  now: number,
): string | null {
  const record = sanitizeDiagnosticRecord(input, now);
  return record === null ? null : JSON.stringify(record);
}

// Minimal filesystem surface, injectable so the sink contract (lazy
// creation, swallowed failures) is unit-testable without touching disk.
export interface DiagnosticsFileSystem {
  existsSync(candidate: string): boolean;
  mkdirSync(candidate: string, options?: { recursive?: boolean }): unknown;
  appendFileSync(
    file: string,
    data: string,
    options?: { encoding?: string },
  ): unknown;
}

const nodeFileSystem: DiagnosticsFileSystem = {
  existsSync: (candidate) => fs.existsSync(candidate),
  mkdirSync: (candidate, options) => fs.mkdirSync(candidate, options),
  appendFileSync: (file, data, options) =>
    fs.appendFileSync(file, data, options as { encoding: "utf8" }),
};

export function diagnosticsDirectory(baseDirectory: string): string {
  return path.join(baseDirectory, DIAGNOSTICS_SUBDIRECTORY_NAME);
}

export function diagnosticsEnableMarkerPath(baseDirectory: string): string {
  return path.join(
    diagnosticsDirectory(baseDirectory),
    DIAGNOSTICS_ENABLE_MARKER_NAME,
  );
}

// UTC run stamp, filesystem-safe: 2026-09-29T10:30:00.123Z ->
// 20260929T103000123Z. The pid + instance suffix is appended to the file
// name so two runs can never overwrite each other's telemetry.
export function diagnosticsTimestampToken(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export interface DiagnosticsSinkOptions {
  enabled: boolean;
  baseDirectory: string;
  now?: () => Date;
  fileSystem?: DiagnosticsFileSystem;
  instanceSuffix?: string;
}

export interface DiagnosticsCounters {
  written: number;
  failedWrites: number;
  rejected: number;
}

export interface DiagnosticsSink extends DiagnosticRecorder {
  readonly enabled: boolean;
  readonly filePath: string;
  readonly counters: DiagnosticsCounters;
}

let sinkInstanceCounter = 0;

// JSON Lines sink. Construction has no filesystem side effects; the first
// accepted record creates the directory. Every write path is wrapped so a
// full disk, a locked file, or a removed directory degrades to a counter
// instead of an exception in the middle of a browser event.
export function createDiagnosticsSink(
  options: DiagnosticsSinkOptions,
): DiagnosticsSink {
  const now = options.now ?? (() => new Date());
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const directory = diagnosticsDirectory(options.baseDirectory);
  sinkInstanceCounter += 1;
  const suffix =
    options.instanceSuffix ?? `p${process.pid}-${sinkInstanceCounter}`;
  const filePath = path.join(
    directory,
    `${DIAGNOSTICS_FILE_PREFIX}${diagnosticsTimestampToken(now())}-${suffix}${DIAGNOSTICS_FILE_EXTENSION}`,
  );
  const counters: DiagnosticsCounters = {
    written: 0,
    failedWrites: 0,
    rejected: 0,
  };
  let directoryEnsured = false;
  const ensureDirectory = (): void => {
    if (directoryEnsured) {
      return;
    }
    fileSystem.mkdirSync(directory, { recursive: true });
    directoryEnsured = true;
  };
  return {
    enabled: options.enabled,
    filePath,
    counters,
    record(input: unknown): void {
      if (!options.enabled) {
        return;
      }
      const line = formatDiagnosticLine(input, now().getTime());
      if (line === null) {
        counters.rejected += 1;
        return;
      }
      try {
        ensureDirectory();
        fileSystem.appendFileSync(filePath, `${line}\n`, { encoding: "utf8" });
        counters.written += 1;
      } catch {
        counters.failedWrites += 1;
      }
    },
  };
}

// The diagnostics directory is a SIBLING of the activated profile directory:
// both live under the per-user %PROGRAMDATA%\youtubetv-for-windows\users\<key>
// base.
export function resolveDiagnosticsBaseDirectory(
  profileDirectory: string,
): string {
  return path.dirname(profileDirectory);
}

export function isDiagnosticsRequested(
  baseDirectory: string,
  fileSystem: DiagnosticsFileSystem = nodeFileSystem,
): boolean {
  return fileSystem.existsSync(diagnosticsEnableMarkerPath(baseDirectory));
}

export interface ProfileDiagnosticsOptions {
  now?: () => Date;
  fileSystem?: DiagnosticsFileSystem;
  instanceSuffix?: string;
}

// Production factory used by the app entry and by the Electron fixture host.
// Returns null (and therefore wires nothing at all) unless the sentinel file
// exists. This is the ONE opt-in read point for the whole application.
export function createProfileDiagnostics(
  profileDirectory: string,
  options?: ProfileDiagnosticsOptions,
): DiagnosticsSink | null {
  const fileSystem = options?.fileSystem ?? nodeFileSystem;
  const baseDirectory = resolveDiagnosticsBaseDirectory(profileDirectory);
  if (!isDiagnosticsRequested(baseDirectory, fileSystem)) {
    return null;
  }
  return createDiagnosticsSink({
    enabled: true,
    baseDirectory,
    now: options?.now,
    fileSystem,
    instanceSuffix: options?.instanceSuffix,
  });
}
