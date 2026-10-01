// Fixed owner-supplied PS4 Leanback Shell identity experiment for the YouTube
// TV host. The device class is PS4 Leanback Shell; the engine token is Cobalt,
// the same Chromium-derived engine the PS4 browser family uses.
// This string is not first-party or manufacturer verified.
//
// The value below is byte-for-byte the owner's supplied string. It must never
// be modified, trimmed, or selected at runtime: there is deliberately no
// override path (no environment variable, CLI flag, config file, or setting
// anywhere in src/). If the string ever fails, repair it through a new
// release, never through a runtime switch.

export const FIXED_USER_AGENT =
  "Mozilla/5.0 (PS4; Leanback Shell) Cobalt/26.android.1.1036236-gold (unlike Gecko) v8/11.4.183.40-jit gles Starboard/17";

export function assertIdentityPolicy(value: string): void {
  if (value !== FIXED_USER_AGENT) {
    throw new Error(
      "The host identity policy rejected a non-fixed user agent; " +
        "only the hard-coded PS4 Leanback Shell string may identify this host.",
    );
  }
}
