/**
 * Strict schema for the signed update manifest.
 *
 * Shape is validated here; policy (supported schema version, channel, release
 * binding, minimum versions, freshness) is validated in `policy.ts` after the
 * signature has been verified. Every check fails closed: an unexpected type,
 * a missing or unknown top-level key, an unsafe `installerAssetName`, or a
 * malformed hash/semver rejects the whole manifest.
 */
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import type { JsonValue } from "./canonical.ts";
import { isJsonObject, parseStrictJson } from "./strict-json.ts";
import { parseSemver } from "./version.ts";

/** Schema version understood by this launcher release. */
export const SUPPORTED_SCHEMA_VERSION = 1;

/** Exact release asset name carrying the manifest. */
export const UPDATE_MANIFEST_ASSET_NAME = "update-manifest.json";

/** Exact release asset name carrying the detached Ed25519 signature. */
export const UPDATE_SIGNATURE_ASSET_NAME = "update-manifest.sig";

export interface UpdateManifest {
  readonly schemaVersion: number;
  readonly keyId: string;
  readonly channel: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly installerAssetName: string;
  readonly size: number;
  readonly sha256: string;
  readonly minBootstrapVersion: string;
  readonly minAppVersion: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

const REQUIRED_KEYS: readonly (keyof UpdateManifest)[] = [
  "schemaVersion",
  "keyId",
  "channel",
  "version",
  "releaseTag",
  "installerAssetName",
  "size",
  "sha256",
  "minBootstrapVersion",
  "minAppVersion",
];

const REQUIRED_KEY_SET: ReadonlySet<string> = new Set<string>(REQUIRED_KEYS);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const MAX_KEY_ID_LENGTH = 128;
const MAX_CHANNEL_LENGTH = 64;
const MAX_RELEASE_TAG_LENGTH = 256;
const MAX_ASSET_NAME_LENGTH = 255;

function isSafeNonNegativeInteger(
  value: JsonValue | undefined,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(
  value: JsonValue | undefined,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

/**
 * Installer asset names become file names inside the pending directory, so
 * separators, traversal spellings, and control characters are rejected rather
 * than sanitized.
 */
function isSafeAssetName(value: JsonValue | undefined): value is string {
  if (!isBoundedString(value, MAX_ASSET_NAME_LENGTH)) {
    return false;
  }
  if (value === "." || value === "..") {
    return false;
  }
  if (value.includes("/") || value.includes("\\")) {
    return false;
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function reject(code: UpdateErrorCode, message: string): ManifestParseResult {
  return { ok: false, code, message };
}

/** Parses and strictly validates manifest text. Never throws. */
export function parseUpdateManifest(text: string): ManifestParseResult {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    return reject(
      parsed.code === "duplicate-json-key"
        ? UPDATE_ERROR_CODES.DUPLICATE_JSON_KEY
        : UPDATE_ERROR_CODES.MALFORMED_MANIFEST_JSON,
      parsed.message,
    );
  }
  if (!isJsonObject(parsed.value)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "the manifest must be a JSON object",
    );
  }
  const record = parsed.value;
  const unknownKeys = Object.keys(record).filter(
    (key) => !REQUIRED_KEY_SET.has(key),
  );
  if (unknownKeys.length > 0) {
    return reject(
      UPDATE_ERROR_CODES.UNKNOWN_MANIFEST_KEY,
      `unknown manifest key(s): ${unknownKeys.sort().join(", ")}`,
    );
  }
  const missingKeys = REQUIRED_KEYS.filter((key) => !(key in record));
  if (missingKeys.length > 0) {
    return reject(
      UPDATE_ERROR_CODES.MISSING_MANIFEST_KEY,
      `missing manifest key(s): ${missingKeys.join(", ")}`,
    );
  }

  const schemaVersion = record.schemaVersion;
  if (!isSafeNonNegativeInteger(schemaVersion) || schemaVersion < 1) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "schemaVersion must be a positive integer",
    );
  }

  const keyId = record.keyId;
  if (!isBoundedString(keyId, MAX_KEY_ID_LENGTH)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "keyId must be a non-empty string",
    );
  }

  const channel = record.channel;
  if (!isBoundedString(channel, MAX_CHANNEL_LENGTH)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "channel must be a non-empty string",
    );
  }

  const version = record.version;
  if (typeof version !== "string") {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "version must be a string",
    );
  }
  if (parseSemver(version) === undefined) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_SEMVER,
      `version is not a semantic version: ${version}`,
    );
  }

  const releaseTag = record.releaseTag;
  if (!isBoundedString(releaseTag, MAX_RELEASE_TAG_LENGTH)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "releaseTag must be a non-empty string",
    );
  }

  const installerAssetName = record.installerAssetName;
  if (!isSafeAssetName(installerAssetName)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "installerAssetName must be a plain file name without path separators",
    );
  }

  const size = record.size;
  if (!isSafeNonNegativeInteger(size) || size < 1) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "size must be a positive integer byte count",
    );
  }

  const sha256 = record.sha256;
  if (typeof sha256 !== "string") {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "sha256 must be a string",
    );
  }
  if (!SHA256_PATTERN.test(sha256)) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_SHA256,
      "sha256 must be exactly 64 lowercase hexadecimal characters",
    );
  }

  const minBootstrapVersion = record.minBootstrapVersion;
  if (typeof minBootstrapVersion !== "string") {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "minBootstrapVersion must be a string",
    );
  }
  if (parseSemver(minBootstrapVersion) === undefined) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_SEMVER,
      `minBootstrapVersion is not a semantic version: ${minBootstrapVersion}`,
    );
  }

  const minAppVersion = record.minAppVersion;
  if (typeof minAppVersion !== "string") {
    return reject(
      UPDATE_ERROR_CODES.INVALID_MANIFEST_FIELD,
      "minAppVersion must be a string",
    );
  }
  if (parseSemver(minAppVersion) === undefined) {
    return reject(
      UPDATE_ERROR_CODES.INVALID_SEMVER,
      `minAppVersion is not a semantic version: ${minAppVersion}`,
    );
  }

  return {
    ok: true,
    manifest: {
      schemaVersion,
      keyId,
      channel,
      version,
      releaseTag,
      installerAssetName,
      size,
      sha256,
      minBootstrapVersion,
      minAppVersion,
    },
  };
}

/**
 * Rebuilds the exact JSON object whose canonical bytes the signature covers.
 * Reconstructing from the validated fields (never reusing the parsed input
 * object) guarantees unknown keys or prototype tricks cannot ride along into
 * the signed payload.
 */
export function toSignableJson(manifest: UpdateManifest): {
  readonly [key: string]: JsonValue;
} {
  return {
    schemaVersion: manifest.schemaVersion,
    keyId: manifest.keyId,
    channel: manifest.channel,
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    installerAssetName: manifest.installerAssetName,
    size: manifest.size,
    sha256: manifest.sha256,
    minBootstrapVersion: manifest.minBootstrapVersion,
    minAppVersion: manifest.minAppVersion,
  };
}
