// Resolve account identity independently of account names and profile paths.
// The system query is synchronous because Electron data paths must precede ready.

import { execFileSync } from "node:child_process";
import path from "node:path";

export type SidResult =
  | { readonly ok: true; readonly sid: string }
  | { readonly ok: false; readonly reason: string };

export interface SidQueryOptions {
  readonly timeout: number;
  readonly windowsHide: boolean;
  readonly maxBuffer: number;
}

export type SyncRunner = (
  file: string,
  args: readonly string[],
  options: SidQueryOptions,
) => unknown;

export const SID_QUERY_ARGUMENTS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
] as const;

export const SID_QUERY_TIMEOUT_MS = 5000;
export const SID_QUERY_MAX_OUTPUT_BYTES = 64 * 1024;

// One Windows SID string: revision 1, an identifier authority, then one or
// more subauthorities. Accepts any authority, including domain accounts
// (S-1-5-...) and Azure AD accounts (S-1-12-...). Rejects anything that is not
// exactly one such token, so a value can never contain a path separator.
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

function decodeOutput(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString(
      "utf8",
    );
  }
  return "";
}

const defaultRunner: SyncRunner = (file, args, options) =>
  execFileSync(file, [...args], {
    timeout: options.timeout,
    windowsHide: options.windowsHide,
    maxBuffer: options.maxBuffer,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });

export function resolveCurrentUserSidSync(
  runner: SyncRunner = defaultRunner,
): SidResult {
  const systemRoot = process.env.SystemRoot?.trim();
  if (
    systemRoot === undefined ||
    systemRoot === "" ||
    !path.isAbsolute(systemRoot)
  ) {
    return { ok: false, reason: "SystemRoot is not an absolute path" };
  }
  const executable = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let raw: unknown;
  try {
    raw = runner(executable, SID_QUERY_ARGUMENTS, {
      timeout: SID_QUERY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: SID_QUERY_MAX_OUTPUT_BYTES,
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? "Windows identity query failed"
          : "Windows identity query failed unexpectedly",
    };
  }
  const candidate = decodeOutput(raw).trim();
  if (!SID_PATTERN.test(candidate)) {
    return {
      ok: false,
      reason: "Windows identity query returned an invalid SID",
    };
  }
  return { ok: true, sid: candidate };
}
