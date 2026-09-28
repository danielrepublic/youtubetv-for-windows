/**
 * Embedded verification keyring.
 *
 * Only PUBLIC keys live here. The paired private key is held exclusively as a
 * GitHub Actions release-environment secret and is never committed, bundled,
 * logged, or readable by pull-request workflows (draft line 182).
 *
 * Two entries exist so a key can be rotated without bricking existing
 * launchers: the `next` key is pre-authorized in an already-shipped release
 * before it becomes `active` for signing. A key compromise still requires a
 * new launcher release containing the replacement key before the old key is
 * revoked.
 *
 * ---------------------------------------------------------------------------
 * RELEASE-BLOCKING: `REPLACE_BEFORE_RELEASE`
 * ---------------------------------------------------------------------------
 * The placeholder below is intentionally not valid SPKI material, so
 * verification fails closed until a release engineer replaces it with the
 * base64-encoded SPKI DER of the release public key:
 *
 *   crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" })
 *     .toString("base64")
 *
 * Key material must be replaced in the same launcher release that publishes
 * the first signed manifest.
 */
export type UpdateKeyStatus = "active" | "next";

export interface UpdateKey {
  readonly keyId: string;
  readonly status: UpdateKeyStatus;
  /** Base64 SPKI DER of an Ed25519 public key. */
  readonly spkiBase64: string;
}

export interface UpdateKeyring {
  readonly keys: readonly UpdateKey[];
}

/** Marker that must never reach a release build. */
export const KEYRING_PLACEHOLDER = "REPLACE_BEFORE_RELEASE";

export const PRODUCTION_KEYRING: UpdateKeyring = Object.freeze({
  keys: Object.freeze([
    Object.freeze({
      keyId: "ytvw-release-primary",
      status: "active",
      spkiBase64: KEYRING_PLACEHOLDER,
    }),
    Object.freeze({
      keyId: "ytvw-release-next",
      status: "next",
      spkiBase64: KEYRING_PLACEHOLDER,
    }),
  ]),
});

/** Finds the key entry for `keyId`; both `active` and `next` keys verify. */
export function resolveVerificationKey(
  keyring: UpdateKeyring,
  keyId: string,
): UpdateKey | undefined {
  return keyring.keys.find((key) => key.keyId === keyId);
}
