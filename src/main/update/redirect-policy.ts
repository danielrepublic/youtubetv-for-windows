/**
 * Host policy for update traffic.
 *
 * Two rules, both fail-closed:
 *
 *   1. An initial request may target only `https://api.github.com` with no
 *      explicit port and no URL credentials. This is the only host that is
 *      trusted to originate a response.
 *   2. At most three HTTPS 302 redirects may be followed, and only to the
 *      documented GitHub release-asset CDN hosts. Any other host, any
 *      downgrade to `http:`, any credentials in the URL, and any revisit of
 *      an already-requested URL is rejected.
 *
 * The redirect target is never treated as an authentication of content: only
 * the signed manifest authenticates the bytes. The policy exists to prevent
 * the launcher from being used as a confused-deputy HTTP client and to keep
 * credentials (which this domain never sends anyway) from leaking to a
 * third-party host.
 */
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";

export const GITHUB_REPOSITORY = "danielrepublic/youtubetv-for-windows";
export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_RELEASES_LATEST_URL = `https://${GITHUB_API_HOST}/repos/${GITHUB_REPOSITORY}/releases/latest`;

/** Documented GitHub release-asset CDN hosts. */
export const GITHUB_ASSET_REDIRECT_HOSTS: readonly string[] = Object.freeze([
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/** At most three 302 hops are followed after the initial request. */
export const MAX_ASSET_REDIRECTS = 3;

/** Fixed, non-configurable User-Agent for GitHub API requests. */
export const UPDATE_USER_AGENT =
  "youtubetv-for-windows-updater/0.1.0 (+https://github.com/danielrepublic/youtubetv-for-windows)";

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

/**
 * Validates the very first URL of an update-related request. Discovery uses
 * the fixed `GITHUB_RELEASES_LATEST_URL`; asset requests use the release
 * asset API URLs, so both must satisfy this same predicate.
 */
export function validateInitialTarget(rawUrl: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.UNSUPPORTED_INITIAL_HOST,
      message: `initial request URL is not a valid absolute URL: ${rawUrl}`,
    };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.INSECURE_INITIAL_URL,
      message: `initial request must use https, received ${url.protocol}//`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.UNSUPPORTED_INITIAL_HOST,
      message: "initial request URL must not contain credentials",
    };
  }
  if (url.hostname !== GITHUB_API_HOST || url.port !== "") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.UNSUPPORTED_INITIAL_HOST,
      message: `initial request host must be ${GITHUB_API_HOST} on the default port, received ${url.host}`,
    };
  }
  return { ok: true, url };
}

/**
 * Validates one redirect hop. `followedCount` is the number of redirects
 * already followed, so the fourth `Location` is rejected before any request
 * is made. `visited` contains every absolute URL already requested.
 */
export function validateRedirectTarget(
  fromUrl: URL,
  location: string,
  followedCount: number,
  visited: ReadonlySet<string>,
): UrlVerdict {
  if (followedCount >= MAX_ASSET_REDIRECTS) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.REDIRECT_LIMIT_EXCEEDED,
      message: `more than ${MAX_ASSET_REDIRECTS} redirects from ${fromUrl.href}`,
    };
  }
  let target: URL;
  try {
    target = new URL(location, fromUrl);
  } catch {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.MALFORMED_REDIRECT,
      message: `redirect Location is not a valid URL: ${location}`,
    };
  }
  if (target.protocol !== "https:") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.INSECURE_REDIRECT,
      message: `redirect must use https, received ${target.protocol}// to ${target.host}`,
    };
  }
  if (target.username !== "" || target.password !== "") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.DISALLOWED_REDIRECT_HOST,
      message: "redirect URL must not contain credentials",
    };
  }
  const hostname = target.hostname.toLowerCase();
  if (target.port !== "" || !GITHUB_ASSET_REDIRECT_HOSTS.includes(hostname)) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.DISALLOWED_REDIRECT_HOST,
      message: `redirect host is not a documented GitHub asset host: ${target.host}`,
    };
  }
  if (visited.has(target.href)) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.REDIRECT_LOOP,
      message: `redirect loop revisited ${target.href}`,
    };
  }
  return { ok: true, url: target };
}
