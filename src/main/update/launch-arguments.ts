/**
 * The ONE sanctioned launch-argument intake in `src/`.
 *
 * Why this module exists: after a verified silent update, `build/nsis.include`
 * relaunches the freshly installed executable with
 *
 *     <app.exe> --update-nonce=<nonce>
 *
 * and the relaunched bootstrap must verify the completed-install marker that
 * belongs to that nonce (`relaunch.ts`). Every other launcher behavior is
 * fixed at build time, so this is the entire runtime-override surface of the
 * application: exactly one flag, a strict character-class allowlist, and no
 * other caller in `src/` may read the process argument vector at all.
 * `test/electron/secure-host.test.mjs` bans argument reads everywhere in
 * `src/` EXCEPT this file, and separately pins that this parser accepts the
 * nonce flag and ignores everything else — so this exception cannot silently
 * grow into a general-purpose override channel.
 *
 * Fail-closed rules:
 *   - the FIRST `--update-nonce` occurrence wins; if its value is malformed
 *     the parser returns null and never looks at a later duplicate (a hostile
 *     duplicate cannot override the first).
 *   - the flag must carry `=`; a bare `--update-nonce` or a different flag
 *     that merely starts with the same prefix (`--update-nonce-evil`) is not
 *     the flag.
 *   - the value must match `[A-Za-z0-9-]{1,128}`: the no-flag-characters,
 *     path-separator-free alphabet used by both the update domain nonce
 *     (32 lowercase hex) and the NSIS include (hex). Anything containing a
 *     path separator, whitespace, quotes, or a drive designator is rejected
 *     before it can ever be joined into a filesystem path.
 */
export const UPDATE_NONCE_FLAG = "--update-nonce";

/** Shared nonce syntax for the update domain and the marker verifier. */
export const UPDATE_NONCE_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/** True only for a value that may be joined into a status-marker path. */
export function isValidUpdateNonce(value: string): boolean {
  return UPDATE_NONCE_PATTERN.test(value);
}

/**
 * Extracts the first `--update-nonce=<value>` from an argument vector.
 * Returns null when the flag is absent or its first occurrence is malformed.
 * Every other argument (including any override-shaped identity, URL, or
 * `/S` style switch) is ignored.
 */
export function parseUpdateNonce(
  argumentsList: readonly string[],
): string | null {
  for (const argument of argumentsList) {
    if (!argument.startsWith(UPDATE_NONCE_FLAG)) {
      continue;
    }
    const separator = argument.charAt(UPDATE_NONCE_FLAG.length);
    if (separator !== "=") {
      // `--update-nonce` with no value, or a longer flag sharing the prefix.
      continue;
    }
    const value = argument.slice(UPDATE_NONCE_FLAG.length + 1);
    return isValidUpdateNonce(value) ? value : null;
  }
  return null;
}

/**
 * Reads the sanctioned nonce from the real process argument vector. This is
 * the only `process.argv` read in `src/`; the guard suite allowlists exactly
 * this call site.
 */
export function readLaunchUpdateNonce(): string | null {
  return parseUpdateNonce(process.argv);
}
