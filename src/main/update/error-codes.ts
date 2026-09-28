/**
 * The single classified-code vocabulary for the update domain.
 *
 * Every rejection path in this domain returns one of these stable kebab-case
 * strings. The strings are part of the observable contract: todo 6 (startup
 * integration) branches on them, the test corpus asserts on them by literal
 * value, and they are written to logs. Never rename one, never introduce an
 * ad-hoc string at a call site.
 *
 * Deliberately a frozen `as const` object rather than a TypeScript `enum`:
 * enums emit runtime code and are not erasable syntax, so they break Node 24
 * native type stripping, which is how this repository executes `.ts` sources
 * in tests.
 *
 * Result classification (see `check-for-update.ts`):
 *   - `skipped` codes mean the check could not be carried out against a
 *     trustworthy candidate (network conditions, a broken upstream release,
 *     or lock contention). The installed version is simply launched.
 *   - `failed` codes mean a candidate release existed but failed trust or
 *     policy validation. The installed version is still launched, and the
 *     caller may additionally surface the bilingual guidance required by the
 *     plan because the update feed is either hostile or broken.
 */
export const UPDATE_ERROR_CODES = Object.freeze({
  // ---------------------------------------------------------------------
  // Transport and discovery. These classify as `skipped`.
  // ---------------------------------------------------------------------

  /** GitHub answered 403/429 with rate-limit headers (or any 429). */
  RATE_LIMITED: "rate-limited",
  /** The bounded AbortController timeout fired. */
  NETWORK_TIMEOUT: "network-timeout",
  /** DNS/connection failure: the machine is offline or GitHub is unreachable. */
  NETWORK_OFFLINE: "network-offline",
  /** Any other transport-level failure. */
  NETWORK_ERROR: "network-error",
  /** A definite non-success HTTP status without a more specific class. */
  HTTP_ERROR: "http-error",
  /** The release body was not a well-formed release object. */
  MALFORMED_RELEASE: "malformed-release",
  /** The release does not belong to the configured repository. */
  WRONG_REPOSITORY: "wrong-repository",
  /** `draft: true` on the latest release. */
  DRAFT_RELEASE: "draft-release",
  /** `prerelease: true` on the latest release. */
  PRERELEASE: "prerelease",
  /** The release has no exact `update-manifest.json` asset. */
  MISSING_MANIFEST_ASSET: "missing-manifest-asset",
  /** The release has no exact `update-manifest.sig` asset. */
  MISSING_SIGNATURE_ASSET: "missing-signature-asset",
  /** Another update attempt holds the per-user lock; no state was touched. */
  LOCK_HELD: "lock-held",

  // ---------------------------------------------------------------------
  // Manifest parsing and signature trust. These classify as `failed`.
  // ---------------------------------------------------------------------

  /** The manifest bytes are not valid JSON. */
  MALFORMED_MANIFEST_JSON: "malformed-manifest-json",
  /**
   * The manifest raw text repeats an object key at some nesting level.
   * `JSON.parse` silently keeps the last value, so this is detected by the
   * strict parser in `strict-json.ts` before any value is trusted.
   */
  DUPLICATE_JSON_KEY: "duplicate-json-key",
  /** `schemaVersion` is not the one supported by this launcher. */
  UNSUPPORTED_SCHEMA_VERSION: "unsupported-schema-version",
  /** A top-level key outside the fixed manifest schema is present. */
  UNKNOWN_MANIFEST_KEY: "unknown-manifest-key",
  /** A required top-level manifest key is absent. */
  MISSING_MANIFEST_KEY: "missing-manifest-key",
  /** A field has the wrong type, shape, or an unsafe value (e.g. path separators). */
  INVALID_MANIFEST_FIELD: "invalid-manifest-field",
  /** `sha256` is not exactly 64 lowercase hex characters. */
  INVALID_SHA256: "invalid-sha256",
  /** A version-like field is not valid semantic-version syntax. */
  INVALID_SEMVER: "invalid-semver",
  /** `channel` is not the allowed stable channel. */
  CHANNEL_NOT_ALLOWED: "channel-not-allowed",
  /** The manifest version carries a prerelease suffix. */
  PRERELEASE_VERSION_UNSUPPORTED: "prerelease-version-unsupported",
  /** `releaseTag` does not match the API release's `tag_name`. */
  RELEASE_TAG_MISMATCH: "release-tag-mismatch",
  /** `installerAssetName` is not among the release's exact asset names. */
  INSTALLER_ASSET_MISMATCH: "installer-asset-mismatch",
  /** `keyId` is not present in the embedded keyring. */
  UNKNOWN_KEY_ID: "unknown-key-id",
  /** The keyring's base64 SPKI material cannot be parsed as a public key. */
  INVALID_KEY_MATERIAL: "invalid-key-material",
  /** Detached Ed25519 verification over the canonical bytes failed. */
  INVALID_SIGNATURE: "invalid-signature",
  /**
   * The manifest version is not newer than the installed app version.
   * This single rule rejects both downgrades and replays of an older,
   * validly signed manifest against a newer installation.
   */
  DOWNGRADE: "downgrade",
  /** `minBootstrapVersion` is newer than the running bootstrap. */
  MIN_BOOTSTRAP_VERSION_UNSUPPORTED: "min-bootstrap-version-unsupported",
  /** `minAppVersion` is newer than the running application. */
  MIN_APP_VERSION_UNSUPPORTED: "min-app-version-unsupported",

  // ---------------------------------------------------------------------
  // Download policy and installer integrity. These classify as `failed`.
  // ---------------------------------------------------------------------

  /** An initial request targeted a host other than `api.github.com`. */
  UNSUPPORTED_INITIAL_HOST: "unsupported-initial-host",
  /** An initial request did not use HTTPS. */
  INSECURE_INITIAL_URL: "insecure-initial-url",
  /** A redirect pointed at a host outside the documented asset CDN hosts. */
  DISALLOWED_REDIRECT_HOST: "disallowed-redirect-host",
  /** A redirect downgraded to `http:`. */
  INSECURE_REDIRECT: "insecure-redirect",
  /** More than three redirects were requested. */
  REDIRECT_LIMIT_EXCEEDED: "redirect-limit-exceeded",
  /** The redirect chain revisited a URL. */
  REDIRECT_LOOP: "redirect-loop",
  /** A 3xx response had no usable `Location` header. */
  MALFORMED_REDIRECT: "malformed-redirect",
  /** The body exceeded the configured byte budget. */
  DOWNLOAD_TOO_LARGE: "download-too-large",
  /** The body ended before its declared length (mid-stream failure). */
  DOWNLOAD_TRUNCATED: "download-truncated",
  /** The downloaded installer was zero bytes. */
  INSTALLER_EMPTY: "installer-empty",
  /** Downloaded byte count differs from the signed manifest `size`. */
  INSTALLER_SIZE_MISMATCH: "installer-size-mismatch",
  /** Streamed SHA-256 differs from the signed manifest `sha256`. */
  INSTALLER_HASH_MISMATCH: "installer-hash-mismatch",
  /** The injected base directory could not be prepared or written. */
  STORAGE_ERROR: "storage-error",
  /** A bug reached the top-level guard; the check never throws. */
  INTERNAL_ERROR: "internal-error",
} as const);

/** Union of every stable classified code. */
export type UpdateErrorCode =
  (typeof UPDATE_ERROR_CODES)[keyof typeof UPDATE_ERROR_CODES];

/**
 * Codes that classify as a `skipped` result: no trustworthy candidate could be
 * evaluated. Everything not listed here classifies as `failed` because a
 * candidate manifest or installer was actually obtained and then rejected.
 */
const SKIP_CODES: ReadonlySet<UpdateErrorCode> = new Set<UpdateErrorCode>([
  UPDATE_ERROR_CODES.RATE_LIMITED,
  UPDATE_ERROR_CODES.NETWORK_TIMEOUT,
  UPDATE_ERROR_CODES.NETWORK_OFFLINE,
  UPDATE_ERROR_CODES.NETWORK_ERROR,
  UPDATE_ERROR_CODES.HTTP_ERROR,
  UPDATE_ERROR_CODES.MALFORMED_RELEASE,
  UPDATE_ERROR_CODES.WRONG_REPOSITORY,
  UPDATE_ERROR_CODES.DRAFT_RELEASE,
  UPDATE_ERROR_CODES.PRERELEASE,
  UPDATE_ERROR_CODES.MISSING_MANIFEST_ASSET,
  UPDATE_ERROR_CODES.MISSING_SIGNATURE_ASSET,
  UPDATE_ERROR_CODES.LOCK_HELD,
]);

/** True when `code` must be reported as a benign `skipped` result. */
export function isSkipCode(code: UpdateErrorCode): boolean {
  return SKIP_CODES.has(code);
}
