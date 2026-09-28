/**
 * Bounded HTTP download helpers for the update domain.
 *
 * The bridge to the network is an injected `fetch`-like function, so the test
 * corpus never touches a socket:
 *
 *     type Transport = (input: string, init: RequestInit) => Promise<Response>;
 *
 * Production passes `globalThis.fetch`; tests pass a deterministic fake.
 *
 * Every request is bounded by an AbortController timeout and made with
 * `redirect: "manual"` so the redirect policy in `redirect-policy.ts` decides
 * where the launcher is allowed to go next. Requests are made with
 * `credentials: "omit"` and carry only the headers explicitly passed in;
 * nothing in this module reads cookies, authorization, or proxy state, and no
 * header is ever copied onto a redirect hop other than the original policy
 * headers (proven by the test corpus).
 *
 * Transient transport failures (timeout, offline, other network errors, and
 * 5xx responses) are retried up to `limits.retries` times. Definite 4xx
 * responses, policy violations, and malformed redirects are not retried.
 */
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import type { UpdateLimits } from "./limits.ts";
import {
  validateInitialTarget,
  validateRedirectTarget,
} from "./redirect-policy.ts";

/** Injected `fetch`-like transport. */
export type Transport = (input: string, init: RequestInit) => Promise<Response>;

export interface DownloadFailure {
  readonly ok: false;
  readonly code: UpdateErrorCode;
  readonly message: string;
}

export interface DownloadSuccess {
  readonly ok: true;
  readonly response: Response;
  readonly finalUrl: string;
  readonly notModified: boolean;
}

export type DownloadOutcome = DownloadSuccess | DownloadFailure;

export interface DownloadRequestOptions {
  /** Exact headers sent on the initial request (never forwarded elsewhere). */
  readonly headers: Readonly<Record<string, string>>;
  /** Maximum accepted body size for this request. */
  readonly maxBytes: number;
  readonly limits: UpdateLimits;
  /**
   * When true, a `304 Not Modified` is a success outcome rather than an
   * `http-error`. Discovery uses this with `If-None-Match` caching.
   */
  readonly allowNotModified?: boolean;
}

export interface BodyReadSuccess {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly text: string;
}

export type BodyReadOutcome = BodyReadSuccess | DownloadFailure;

const TIMEOUT_ERROR_CODES = new Set<string>([
  "ABORT_ERR",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const OFFLINE_ERROR_CODES = new Set<string>([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current !== null && current !== undefined;
    depth += 1
  ) {
    if (typeof current !== "object") {
      break;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      codes.push(code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const codes = collectErrorCodes(error);
    const suffix = codes.length > 0 ? ` (${codes.join(", ")})` : "";
    return `${error.name}: ${error.message}${suffix}`;
  }
  return String(error);
}

function classifyTransportError(
  error: unknown,
  aborted: boolean,
): DownloadFailure {
  if (aborted) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.NETWORK_TIMEOUT,
      message: "the update request exceeded its time budget",
    };
  }
  const codes = collectErrorCodes(error);
  if (codes.some((code) => TIMEOUT_ERROR_CODES.has(code))) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.NETWORK_TIMEOUT,
      message: `the update request timed out: ${describeError(error)}`,
    };
  }
  if (codes.some((code) => OFFLINE_ERROR_CODES.has(code))) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.NETWORK_OFFLINE,
      message: `the network is unavailable: ${describeError(error)}`,
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.NETWORK_TIMEOUT,
      message: `the update request was aborted: ${describeError(error)}`,
    };
  }
  return {
    ok: false,
    code: UPDATE_ERROR_CODES.NETWORK_ERROR,
    message: `the update request failed: ${describeError(error)}`,
  };
}

/**
 * True when a response is a rate-limit answer. Any 429 counts; a 403 counts
 * only when it carries GitHub's rate-limit or Retry-After headers, so a plain
 * forbidden response is reported as an HTTP error instead.
 */
export function isRateLimitedResponse(
  status: number,
  headers: Headers,
): boolean {
  if (status === 429) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  return (
    headers.get("x-ratelimit-remaining") === "0" ||
    headers.get("retry-after") !== null ||
    headers.get("x-ratelimit-reset") !== null
  );
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

interface SingleRequestSuccess {
  readonly ok: true;
  readonly response: Response;
}

interface SingleRequestFailure {
  readonly ok: false;
  readonly failure: DownloadFailure;
  readonly retryable: boolean;
}

async function singleRequest(
  transport: Transport,
  url: URL,
  headers: Readonly<Record<string, string>>,
  limits: UpdateLimits,
): Promise<SingleRequestSuccess | SingleRequestFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, limits.requestTimeoutMs);
  try {
    const response = await transport(url.href, {
      method: "GET",
      headers: { ...headers },
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    return { ok: true, response };
  } catch (error) {
    const failure = classifyTransportError(error, controller.signal.aborted);
    const retryable =
      failure.code === UPDATE_ERROR_CODES.NETWORK_TIMEOUT ||
      failure.code === UPDATE_ERROR_CODES.NETWORK_OFFLINE ||
      failure.code === UPDATE_ERROR_CODES.NETWORK_ERROR;
    return { ok: false, failure, retryable };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One hop, with retries for transient failures. A 5xx response is retried
 * inside this function; a 4xx response is returned to the caller as-is.
 */
async function requestHop(
  transport: Transport,
  url: URL,
  headers: Readonly<Record<string, string>>,
  limits: UpdateLimits,
): Promise<SingleRequestSuccess | DownloadFailure> {
  let lastFailure: DownloadFailure = {
    ok: false,
    code: UPDATE_ERROR_CODES.NETWORK_ERROR,
    message: "the update request failed without a classified cause",
  };
  for (let attempt = 0; attempt <= limits.retries; attempt += 1) {
    if (attempt > 0 && limits.retryDelayMs > 0) {
      await sleep(limits.retryDelayMs);
    }
    const outcome = await singleRequest(transport, url, headers, limits);
    if (outcome.ok) {
      if (outcome.response.status >= 500) {
        lastFailure = {
          ok: false,
          code: UPDATE_ERROR_CODES.HTTP_ERROR,
          message: `the update endpoint answered HTTP ${outcome.response.status}`,
        };
        continue;
      }
      return outcome;
    }
    if (!outcome.retryable) {
      return outcome.failure;
    }
    lastFailure = outcome.failure;
  }
  return lastFailure;
}

/**
 * Performs a bounded GET with the redirect policy applied. On success the
 * caller owns the response body stream.
 */
export async function openDownloadStream(
  transport: Transport,
  rawUrl: string,
  options: DownloadRequestOptions,
): Promise<DownloadOutcome> {
  const initial = validateInitialTarget(rawUrl);
  if (!initial.ok) {
    return { ok: false, code: initial.code, message: initial.message };
  }
  let current = initial.url;
  const visited = new Set<string>([current.href]);
  let followedRedirects = 0;

  for (;;) {
    const outcome = await requestHop(
      transport,
      current,
      options.headers,
      options.limits,
    );
    if (!outcome.ok) {
      return outcome;
    }
    const response = outcome.response;

    if (response.status === 302) {
      const location = response.headers.get("location");
      if (location === null || location.trim() === "") {
        return {
          ok: false,
          code: UPDATE_ERROR_CODES.MALFORMED_REDIRECT,
          message: "a 302 response carried no Location header",
        };
      }
      const verdict = validateRedirectTarget(
        current,
        location,
        followedRedirects,
        visited,
      );
      if (!verdict.ok) {
        return { ok: false, code: verdict.code, message: verdict.message };
      }
      followedRedirects += 1;
      visited.add(verdict.url.href);
      current = verdict.url;
      continue;
    }

    if (response.status === 200) {
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const declared = Number(declaredLength);
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          return {
            ok: false,
            code: UPDATE_ERROR_CODES.DOWNLOAD_TOO_LARGE,
            message: `the response declares ${declared} bytes, over the ${options.maxBytes} byte budget`,
          };
        }
      }
      return {
        ok: true,
        response,
        finalUrl: current.href,
        notModified: false,
      };
    }

    if (response.status === 304 && options.allowNotModified === true) {
      return {
        ok: true,
        response,
        finalUrl: current.href,
        notModified: true,
      };
    }

    if (response.status === 304) {
      return {
        ok: false,
        code: UPDATE_ERROR_CODES.HTTP_ERROR,
        message: "HTTP 304 without a conditional request",
      };
    }

    if (isRateLimitedResponse(response.status, response.headers)) {
      return {
        ok: false,
        code: UPDATE_ERROR_CODES.RATE_LIMITED,
        message: `GitHub rate-limited the update request (HTTP ${response.status})`,
      };
    }
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.HTTP_ERROR,
      message: `the update endpoint answered HTTP ${response.status}`,
    };
  }
}

/**
 * Reads a response body into memory with a byte budget and a declared-length
 * cross-check. A stream error or a short body is classified as
 * `download-truncated`; exceeding the budget is `download-too-large`.
 */
export async function readBodyBytes(
  response: Response,
  maxBytes: number,
): Promise<BodyReadOutcome> {
  const declaredText = response.headers.get("content-length");
  const declared = declaredText === null ? undefined : Number(declaredText);
  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body;
  if (body !== null) {
    try {
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          return {
            ok: false,
            code: UPDATE_ERROR_CODES.DOWNLOAD_TOO_LARGE,
            message: `the response body exceeded the ${maxBytes} byte budget`,
          };
        }
        chunks.push(buffer);
      }
    } catch (error) {
      return {
        ok: false,
        code: UPDATE_ERROR_CODES.DOWNLOAD_TRUNCATED,
        message: `the response body ended early: ${describeError(error)}`,
      };
    }
  }
  const bytes = Buffer.concat(chunks, total);
  if (
    declared !== undefined &&
    Number.isFinite(declared) &&
    declared !== total
  ) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.DOWNLOAD_TRUNCATED,
      message: `the response body is ${total} bytes but ${declared} were declared`,
    };
  }
  return { ok: true, bytes, text: bytes.toString("utf8") };
}
