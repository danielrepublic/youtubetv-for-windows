// Fixed first-party-verified PS4 Leanback identity for the YouTube TV host.
//
// The value below is byte-for-byte the owner's verified string. It must never
// be modified, trimmed, or selected at runtime: there is deliberately no
// override path (no environment variable, CLI flag, config file, or setting
// anywhere in src/). If the string ever fails, repair it through a new
// release, never through a runtime switch.

export const FIXED_USER_AGENT =
  "Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)";

export function assertIdentityPolicy(value: string): void {
  if (value !== FIXED_USER_AGENT) {
    throw new Error(
      "The host identity policy rejected a non-fixed user agent; " +
        "only the hard-coded PS4 Leanback string may identify this host.",
    );
  }
}
