/**
 * GitHub `releases/latest` discovery with ETag caching.
 *
 * Contract (plan line 54):
 *   - unauthenticated GET of the configured repository's latest release,
 *   - fixed User-Agent,
 *   - bounded timeout and retry policy (enforced by `http-download.ts`),
 *   - cached ETag sent as `If-None-Match`; a 304 reuses the cached release,
 *   - draft, prerelease, wrong-repository, and malformed responses are
 *     classified skip results, never thrown into startup.
 *
 * The release body is treated as untrusted input: strict JSON parsing and
 * exact field checks decide what the launcher is willing to believe. The only
 * things used from the response are `tag_name`, the repository identity, the
 * draft/prerelease flags, and the exact asset names/URLs.
 */
import type { JsonValue } from "./canonical.ts";
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import {
  openDownloadStream,
  readBodyBytes,
  type Transport,
} from "./http-download.ts";
import type { UpdateLimits } from "./limits.ts";
import {
  UPDATE_MANIFEST_ASSET_NAME,
  UPDATE_SIGNATURE_ASSET_NAME,
} from "./manifest-schema.ts";
import {
  GITHUB_API_HOST,
  GITHUB_RELEASES_LATEST_URL,
  GITHUB_REPOSITORY,
  UPDATE_USER_AGENT,
} from "./redirect-policy.ts";
import { isJsonObject, parseStrictJson } from "./strict-json.ts";

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly url: string;
}

export interface GitHubRelease {
  readonly tagName: string;
  readonly url: string;
  readonly htmlUrl: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly GitHubReleaseAsset[];
}

export interface EtagCacheEntry {
  readonly etag: string;
  /** Raw release JSON body the ETag identifies. */
  readonly body: string;
}

/** Injectable ETag cache; production uses the in-memory implementation. */
export interface EtagCache {
  get(key: string): EtagCacheEntry | undefined;
  set(key: string, entry: EtagCacheEntry): void;
}

/** Process-lifetime cache; the update check runs once per launch. */
export function createMemoryEtagCache(): EtagCache {
  const entries = new Map<string, EtagCacheEntry>();
  return {
    get(key) {
      return entries.get(key);
    },
    set(key, entry) {
      entries.set(key, entry);
    },
  };
}

export type ReleaseDiscovery =
  | {
      readonly ok: true;
      readonly release: GitHubRelease;
      readonly fromCache: boolean;
    }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

export interface DiscoverLatestReleaseOptions {
  readonly transport: Transport;
  readonly etagCache: EtagCache;
  readonly limits: UpdateLimits;
}

const API_RELEASE_PREFIX = `https://${GITHUB_API_HOST}/repos/`;
const RELEASE_HTML_PREFIX = "https://github.com/";
const GITHUB_REPOSITORY_LOWER = GITHUB_REPOSITORY.toLowerCase();

function reject(code: UpdateErrorCode, message: string): ReleaseDiscovery {
  return { ok: false, code, message };
}

function readBoundedString(
  record: { readonly [key: string]: JsonValue },
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return undefined;
  }
  return value;
}

function parseAsset(value: JsonValue): GitHubReleaseAsset | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const name = readBoundedString(value, "name", 255);
  const url = readBoundedString(value, "url", 2048);
  if (name === undefined || url === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { name, url };
}

/** Parses and validates a release body. Never throws. */
export function parseGitHubRelease(text: string): ReleaseDiscovery {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      `the release body is not strict JSON: ${parsed.message}`,
    );
  }
  if (!isJsonObject(parsed.value)) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body is not a JSON object",
    );
  }
  const record = parsed.value;

  const draft = record.draft;
  if (typeof draft !== "boolean") {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no boolean draft flag",
    );
  }
  if (draft) {
    return reject(
      UPDATE_ERROR_CODES.DRAFT_RELEASE,
      "the latest release is a draft",
    );
  }

  const prerelease = record.prerelease;
  if (typeof prerelease !== "boolean") {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no boolean prerelease flag",
    );
  }
  if (prerelease) {
    return reject(
      UPDATE_ERROR_CODES.PRERELEASE,
      "the latest release is a prerelease",
    );
  }

  const tagName = readBoundedString(record, "tag_name", 256);
  if (tagName === undefined) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no usable tag_name",
    );
  }

  const expectedRepository = GITHUB_REPOSITORY_LOWER;
  const url = readBoundedString(record, "url", 2048);
  if (url === undefined) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no usable url",
    );
  }
  const urlLower = url.toLowerCase();
  if (
    !urlLower.startsWith(`${API_RELEASE_PREFIX}${expectedRepository}/releases/`)
  ) {
    return reject(
      UPDATE_ERROR_CODES.WRONG_REPOSITORY,
      `the release URL does not belong to the configured repository: ${url}`,
    );
  }
  const htmlUrl = readBoundedString(record, "html_url", 2048);
  if (htmlUrl === undefined) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no usable html_url",
    );
  }
  const htmlLower = htmlUrl.toLowerCase();
  if (
    !htmlLower.startsWith(
      `${RELEASE_HTML_PREFIX}${expectedRepository}/releases/`,
    )
  ) {
    return reject(
      UPDATE_ERROR_CODES.WRONG_REPOSITORY,
      `the release html_url does not belong to the configured repository: ${htmlUrl}`,
    );
  }

  const assetsValue = record.assets;
  if (!Array.isArray(assetsValue)) {
    return reject(
      UPDATE_ERROR_CODES.MALFORMED_RELEASE,
      "the release body has no assets array",
    );
  }
  const assets: GitHubReleaseAsset[] = [];
  for (const assetValue of assetsValue) {
    const asset = parseAsset(assetValue);
    if (asset === undefined) {
      return reject(
        UPDATE_ERROR_CODES.MALFORMED_RELEASE,
        "the release body contains a malformed asset entry",
      );
    }
    assets.push(asset);
  }

  return {
    ok: true,
    release: {
      tagName,
      url,
      htmlUrl,
      draft,
      prerelease,
      assets,
    },
    fromCache: false,
  };
}

export type AssetLookup =
  | { readonly ok: true; readonly asset: GitHubReleaseAsset }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

function lookupAsset(
  release: GitHubRelease,
  name: string,
  missingCode: UpdateErrorCode,
): AssetLookup {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    return {
      ok: false,
      code: missingCode,
      message: `the release has no ${name} asset`,
    };
  }
  return { ok: true, asset };
}

/** Finds the exact manifest asset, or classifies its absence. */
export function findManifestAsset(release: GitHubRelease): AssetLookup {
  return lookupAsset(
    release,
    UPDATE_MANIFEST_ASSET_NAME,
    UPDATE_ERROR_CODES.MISSING_MANIFEST_ASSET,
  );
}

/** Finds the exact signature asset, or classifies its absence. */
export function findSignatureAsset(release: GitHubRelease): AssetLookup {
  return lookupAsset(
    release,
    UPDATE_SIGNATURE_ASSET_NAME,
    UPDATE_ERROR_CODES.MISSING_SIGNATURE_ASSET,
  );
}

/**
 * Fetches and validates the latest release. Always resolves; failures are
 * classified and belong to the `skipped` result class.
 */
export async function discoverLatestRelease(
  options: DiscoverLatestReleaseOptions,
): Promise<ReleaseDiscovery> {
  const { transport, etagCache, limits } = options;
  const cached = etagCache.get(GITHUB_RELEASES_LATEST_URL);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": UPDATE_USER_AGENT,
  };
  if (cached !== undefined) {
    headers["if-none-match"] = cached.etag;
  }

  const outcome = await openDownloadStream(
    transport,
    GITHUB_RELEASES_LATEST_URL,
    {
      headers,
      maxBytes: limits.maxManifestBytes,
      limits,
      allowNotModified: true,
    },
  );
  if (!outcome.ok) {
    return reject(outcome.code, outcome.message);
  }
  if (outcome.notModified) {
    if (cached === undefined) {
      return reject(
        UPDATE_ERROR_CODES.HTTP_ERROR,
        "GitHub answered 304 but no cached release is available",
      );
    }
    const parsed = parseGitHubRelease(cached.body);
    if (!parsed.ok) {
      return parsed;
    }
    return { ok: true, release: parsed.release, fromCache: true };
  }

  const body = await readBodyBytes(outcome.response, limits.maxManifestBytes);
  if (!body.ok) {
    return reject(body.code, body.message);
  }
  const parsed = parseGitHubRelease(body.text);
  if (!parsed.ok) {
    return parsed;
  }
  const etag = outcome.response.headers.get("etag");
  if (etag !== null && etag.trim() !== "") {
    etagCache.set(GITHUB_RELEASES_LATEST_URL, { etag, body: body.text });
  }
  return parsed;
}
