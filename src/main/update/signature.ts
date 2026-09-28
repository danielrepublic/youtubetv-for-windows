/**
 * Detached Ed25519 verification of the update manifest.
 *
 * The signature covers the canonical UTF-8 bytes of the manifest object (see
 * `canonical.ts`), not the bytes received from the network. Verification runs
 * BEFORE any manifest field is used for a decision: the function only needs
 * `keyId` to select the key, and that too comes from the signed object.
 *
 * There is deliberately no signing code in `src/`: the production signer is
 * the protected release workflow and holds the private key as an Actions
 * secret. Tests generate an ephemeral keypair in-process.
 */
import {
  createPublicKey,
  verify as verifyEd25519,
  type KeyObject,
} from "node:crypto";
import { canonicalBytes } from "./canonical.ts";
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import { resolveVerificationKey, type UpdateKeyring } from "./keyring.ts";
import { toSignableJson, type UpdateManifest } from "./manifest-schema.ts";

export type SignatureVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

const ED25519_SIGNATURE_BYTES = 64;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeSignature(signatureBase64: string): Buffer | undefined {
  const trimmed = signatureBase64.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length % 4 !== 0 ||
    !BASE64_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(trimmed, "base64");
  return decoded.length === ED25519_SIGNATURE_BYTES ? decoded : undefined;
}

export interface VerifyManifestSignatureOptions {
  readonly keyring: UpdateKeyring;
  readonly manifest: UpdateManifest;
  /** Base64 detached signature; surrounding whitespace is tolerated. */
  readonly signatureBase64: string;
}

/** Verifies the detached signature over the manifest's canonical bytes. */
export function verifyManifestSignature(
  options: VerifyManifestSignatureOptions,
): SignatureVerification {
  const key = resolveVerificationKey(options.keyring, options.manifest.keyId);
  if (key === undefined) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.UNKNOWN_KEY_ID,
      message: `keyId is not present in the embedded keyring: ${options.manifest.keyId}`,
    };
  }
  const signature = decodeSignature(options.signatureBase64);
  if (signature === undefined) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.INVALID_SIGNATURE,
      message: "the detached signature is not 64 base64-encoded bytes",
    };
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(key.spkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.INVALID_KEY_MATERIAL,
      message: `keyring entry ${key.keyId} is not valid SPKI public key material: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const signedBytes = canonicalBytes(toSignableJson(options.manifest));
  const valid = verifyEd25519(null, signedBytes, publicKey, signature);
  if (!valid) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.INVALID_SIGNATURE,
      message:
        "the detached signature does not match the canonical manifest bytes",
    };
  }
  return { ok: true };
}
