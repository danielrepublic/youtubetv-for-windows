// Least-privilege ACL for per-user profile directories (issue #2).
//
// The installer grants the local Users group modify on the machine-wide data
// root (so every user can create their own subtree), and that grant is
// inherited by each per-SID directory. A real two-account test proved another
// local standard user can read, append, create in, delete from, and
// recursively delete a user's
// `%PROGRAMDATA%\youtubetv-for-windows\users\by-sid\<SID>\profile` tree through
// that inherited grant.
//
// The fix is enforced AT RUNTIME, by the app itself running as a standard
// user, on every launch, after the `<SID>` directory exists. The app is that
// directory's owner/creator, so it can rewrite its DACL without elevating.
// Three ordered icacls steps: freeze inheritance (`/inheritance:d`, which
// copies the inherited ACEs to explicit and marks the DACL protected), remove
// the inherited Users grant (`/remove:g *S-1-5-32-545`), then grant only the
// owner full control (`/grant *<sid>:(OI)(CI)F`). SYSTEM and Administrators
// keep their inherited full-control ACEs (frozen in place); nothing else is
// named.
//
// WHY icacls AND NOT Set-Acl / .NET SetAccessControl: writing a security
// descriptor that still carries the read SACL requires SeSecurityPrivilege,
// which a standard user does not hold, and both Set-Acl and
// DirectorySecurity.SetAccessControl demand it. icacls edits only the DACL and
// runs unelevated. The Get-Acl/Set-Acl cmdlets are also unusable here because
// Microsoft.PowerShell.Security fails to autoload on some machines.
//
// Children created AFTER the hardening inherit the protected DACL. Children
// that already exist (created while the subtree was still open) are reset once
// via `icacls <child> /reset /T`, which re-inherits from the now-protected
// parent; a marker file `.acl-hardened` (content `1`) records that the one-time
// reset ran.
//
// FAIL-CLOSED CONTRACT: any nonzero exit, any spawn/filesystem error, an
// invalid SID, a reparse-point directory, an owner mismatch, or a missing /
// non-absolute SystemRoot returns `{ ok: false; reason }` and the caller falls
// back to the existing temp profile. This module never throws on expected
// failure and never elevates: the app stays asInvoker.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SID_PATTERN } from "./windows-user-identity.ts";

export type HardenAclResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface HardenAclRunnerOptions {
  readonly timeout: number;
  readonly windowsHide: boolean;
}

export type HardenAclRunner = (
  file: string,
  args: readonly string[],
  options: HardenAclRunnerOptions,
) => unknown;

// Minimal filesystem surface, injectable so tests can simulate every branch
// without spawning PowerShell/icacls or touching the real disk.
export interface ProfileAclFileSystem {
  existsSync(candidate: string): boolean;
  readdirSync(
    candidate: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean }[];
  writeFileSync(candidate: string, data: string, encoding?: "utf8"): void;
}

export interface HardenProfileDirectoryDeps {
  runner?: HardenAclRunner;
  fileSystem?: ProfileAclFileSystem;
  // Overrides the SystemRoot environment read (the same validation applies).
  // Production leaves this unset so the real SystemRoot is used.
  systemRoot?: string | undefined | null;
}

export const HARDEN_ACL_TIMEOUT_MS = 5000;
export const PROFILE_ACL_MARKER_NAME = ".acl-hardened";
export const PROFILE_ACL_MARKER_CONTENT = "1";
export const USERS_SID = "S-1-5-32-545";
export const ADMINISTRATORS_SID = "S-1-5-32-544";

const defaultRunner: HardenAclRunner = (file, args, options) =>
  execFileSync(file, [...args], {
    timeout: options.timeout,
    windowsHide: options.windowsHide,
    stdio: ["ignore", "pipe", "pipe"],
  });

const nodeFileSystem: ProfileAclFileSystem = {
  existsSync: (candidate) => fs.existsSync(candidate),
  readdirSync: (candidate, options) => fs.readdirSync(candidate, options),
  writeFileSync: (candidate, data, encoding) => {
    fs.writeFileSync(candidate, data, encoding);
  },
};

function fail(reason: string): HardenAclResult {
  return { ok: false, reason };
}

function toPowerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Applies the protected DACL to `directory` (which must already exist and be
// owned by `sid`) on every call, and runs the one-time descendant reset when
// the marker is absent. The guard's exit contract: 0 = ok, 2 = reparse point,
// 3 = owner mismatch, any other nonzero = failure.
export function hardenProfileDirectory(
  directory: string,
  sid: string,
  deps: HardenProfileDirectoryDeps = {},
): HardenAclResult {
  if (!SID_PATTERN.test(sid)) {
    return fail("hardenProfileDirectory refused an invalid SID");
  }
  if (directory === "") {
    return fail("hardenProfileDirectory refused an empty directory");
  }
  const rawRoot = deps.systemRoot ?? process.env.SystemRoot?.trim();
  const systemRoot = typeof rawRoot === "string" ? rawRoot.trim() : "";
  if (systemRoot === "" || !path.isAbsolute(systemRoot)) {
    return fail("SystemRoot is not an absolute path");
  }
  const fileSystem = deps.fileSystem ?? nodeFileSystem;
  const runner = deps.runner ?? defaultRunner;
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const icacls = path.join(systemRoot, "System32", "icacls.exe");

  // Guard: refuse a reparse point, and refuse a directory owned by a
  // DIFFERENT account. An elevated process owns its directories as
  // Administrators, so that owner is accepted too (production is asInvoker).
  const guard = [
    "$ErrorActionPreference='Stop'",
    `$p=${toPowerShellSingleQuoted(directory)}`,
    "$di=New-Object System.IO.DirectoryInfo -ArgumentList $p",
    "if(([int]$di.Attributes -band 0x400) -ne 0){exit 2}",
    "$own=$di.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    `if($own -ne ${toPowerShellSingleQuoted(sid)} -and $own -ne '${ADMINISTRATORS_SID}'){exit 3}`,
    "exit 0",
  ].join(";");
  try {
    runner(powershell, ["-NoProfile", "-NonInteractive", "-Command", guard], {
      timeout: HARDEN_ACL_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return fail("profile directory ACL guard failed");
  }

  const icaclsStep = (
    args: readonly string[],
    reason: string,
  ): HardenAclResult => {
    try {
      runner(icacls, [...args], {
        timeout: HARDEN_ACL_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      return fail(reason);
    }
    return { ok: true };
  };

  // Freeze inheritance, strip the shared Users grant, then grant only the owner.
  for (const [args, reason] of [
    [[directory, "/inheritance:d"], "profile directory ACL freeze failed"],
    [
      [directory, "/remove:g", `*${USERS_SID}`],
      "profile directory Users grant removal failed",
    ],
    [
      [directory, "/grant", `*${sid}:(OI)(CI)F`],
      "profile directory owner grant failed",
    ],
  ] as const) {
    const step = icaclsStep(args, reason);
    if (!step.ok) {
      return step;
    }
  }

  let hardened: boolean;
  try {
    hardened = fileSystem.existsSync(
      path.join(directory, PROFILE_ACL_MARKER_NAME),
    );
  } catch {
    return fail("profile directory ACL marker check failed");
  }
  if (hardened) {
    return { ok: true };
  }
  let children: { name: string; isDirectory(): boolean }[];
  try {
    children = fileSystem.readdirSync(directory, { withFileTypes: true });
  } catch {
    return fail("profile directory child enumeration failed");
  }
  for (const child of children) {
    if (!child.isDirectory()) {
      continue;
    }
    const step = icaclsStep(
      [path.join(directory, child.name), "/reset", "/T", "/C", "/Q"],
      "profile directory descendant reset failed",
    );
    if (!step.ok) {
      return step;
    }
  }
  try {
    fileSystem.writeFileSync(
      path.join(directory, PROFILE_ACL_MARKER_NAME),
      PROFILE_ACL_MARKER_CONTENT,
      "utf8",
    );
  } catch {
    return fail("profile directory ACL marker write failed");
  }
  return { ok: true };
}
