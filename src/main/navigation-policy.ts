// Main-window navigation policy: what the TV host window may load in place,
// what leaves to the OS browser, and how a lost TV route recovers.
//
// IN-WINDOW RULE: only https: URLs on youtube.com and its subdomains may
// navigate the main window. The YouTube TV app's own internal navigation
// within youtube.com is never intercepted beyond this host/scheme check.
// Anything else is an unexpected navigation: the event is cancelled, and a
// valid https: target is delegated to the injected openExternal
// (production: shell.openExternal) with no dialog; non-https targets
// (http:, javascript:, file:, data:, custom schemes, malformed URLs) are
// denied silently with no external call.
//
// TV ROUTE RULE: the TV interface lives at path /tv (variants with hash or
// query are fine). A finished load on youtube.com whose path is NOT the TV
// route is the known "redirected-away" failure mode (the TV route bounced
// to plain youtube.com); did-fail-load is "load-failed". Both show the
// bilingual failure dialog with exactly three actions — Retry, Open in
// browser (validated https: only), Support (the release page via
// openExternal) — with bounded retries and no infinite loop.

import type { DiagnosticInput, DiagnosticRecorder } from "./diagnostics.ts";
import { SUPPORT_RELEASE_URL, showRouteFailureDialog } from "./dialogs.ts";
import type {
  DialogPresenter,
  RouteFailureAction,
  RouteFailureKind,
} from "./dialogs.ts";

export type TvRouteOutcome = "ok" | RouteFailureKind;

export type MainNavigationDecision = "allow" | "open-external" | "deny";

// Bounded recovery attempts after the failure dialog. Retry decrements the
// budget; reaching zero stops the loop (retries-exhausted) instead of
// re-showing the dialog forever.
export const MAX_ROUTE_RETRIES = 2;

export const YOUTUBE_HOST = "youtube.com";

// youtube.com and its subdomains (www., m., music., …). Hostnames from URL
// are already lowercased; the suffix check requires a dot boundary so
// notyoutube.com or youtube.com.evil.example never match.
export function isYoutubeHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === YOUTUBE_HOST || normalized.endsWith(`.${YOUTUBE_HOST}`);
}

function parseHttpsUrl(rawUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") {
    return null;
  }
  return parsed;
}

// Pure TV-route classifier, unit-testable without Electron. ok when the
// final URL host is youtube.com (+ subdomains) and the path is /tv or
// starts with /tv/ (hash/query variants are fine — URL parsing keeps them
// out of pathname). redirected-away when the host is youtube.com but the
// path is not the TV route, or when the URL is valid but not youtube.com
// at all (unexpected navigation that still needs the failure dialog rather
// than a silent dead end). load-failed for malformed URLs.
export function classifyTvRouteUrl(rawUrl: string): TvRouteOutcome {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "load-failed";
  }
  if (!isYoutubeHost(parsed.hostname)) {
    return "redirected-away";
  }
  const pathname = parsed.pathname;
  if (pathname === "/tv" || pathname.startsWith("/tv/")) {
    return "ok";
  }
  return "redirected-away";
}

// Pure main-window navigation decision. allow only for https: youtube.com
// hosts; open-external for any other VALID https: URL (the scheme check
// already excluded javascript:/file:/data:/custom schemes); deny silently
// for everything else, including malformed input.
export function decideMainNavigation(rawUrl: string): MainNavigationDecision {
  const parsed = parseHttpsUrl(rawUrl);
  if (parsed === null) {
    return "deny";
  }
  if (isYoutubeHost(parsed.hostname)) {
    return "allow";
  }
  return "open-external";
}

export interface NavigationEvent {
  preventDefault(): void;
}

export interface ExternalOpener {
  openExternal(url: string): void | Promise<void>;
}

// Handles one will-navigate/will-redirect target: allowed targets pass
// through untouched; anything else is cancelled, with valid https: targets
// delegated externally and the rest denied silently.
export function handleMainNavigation(
  opener: ExternalOpener,
  event: NavigationEvent,
  rawUrl: string,
): MainNavigationDecision {
  const decision = decideMainNavigation(rawUrl);
  if (decision === "allow") {
    return decision;
  }
  event.preventDefault();
  if (decision === "open-external") {
    void opener.openExternal(rawUrl);
  }
  return decision;
}

export interface RouteRecoveryDeps {
  kind: RouteFailureKind;
  failedUrl: string;
  targetUrl: string;
  maxRetries?: number;
  presenter: DialogPresenter;
  opener: ExternalOpener;
  reload: () => Promise<string>;
}

export type RouteRecoveryOutcome =
  "recovered" | "dismissed-external" | "retries-exhausted";

function safeBrowserUrl(failedUrl: string, targetUrl: string): string {
  return parseHttpsUrl(failedUrl) === null ? targetUrl : failedUrl;
}

// Bounded bilingual recovery loop: shows the three-action failure dialog,
// retries the target and re-classifies, delegates validated https: URLs to
// the OS browser, and opens the support release page. Never loops forever:
// each retry consumes one attempt and exhaustion returns
// retries-exhausted without showing the dialog again.
export async function recoverTvRoute(
  deps: RouteRecoveryDeps,
): Promise<RouteRecoveryOutcome> {
  const budget = deps.maxRetries ?? MAX_ROUTE_RETRIES;
  let kind = deps.kind;
  let failedUrl = deps.failedUrl;
  let attempt = 0;
  for (;;) {
    const action: RouteFailureAction = await showRouteFailureDialog(
      deps.presenter,
      { kind, failedUrl, attempt },
    );
    if (action === "open-browser") {
      await deps.opener.openExternal(safeBrowserUrl(failedUrl, deps.targetUrl));
      return "dismissed-external";
    }
    if (action === "support") {
      await deps.opener.openExternal(SUPPORT_RELEASE_URL);
      return "dismissed-external";
    }
    if (attempt >= budget) {
      return "retries-exhausted";
    }
    attempt += 1;
    let reloaded: string | null;
    try {
      reloaded = await deps.reload();
    } catch {
      reloaded = null;
    }
    const next =
      reloaded === null ? "load-failed" : classifyTvRouteUrl(reloaded);
    if (next === "ok") {
      return "recovered";
    }
    kind = next;
    failedUrl = reloaded ?? failedUrl;
  }
}

// Structural Electron webContents surface for wiring (kept structural so
// the policy installs against fakes in tests and the real WebContents in
// production without importing Electron types here).
export interface NavigationPolicyContents {
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: NavigationEvent, url: string) => void,
  ): unknown;
  on(
    event: "did-navigate",
    listener: (event: NavigationEvent, url: string) => void,
  ): unknown;
  on(event: "did-finish-load", listener: () => void): unknown;
  on(
    event: "did-fail-load",
    listener: (
      event: NavigationEvent,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  getURL(): string;
  loadURL(url: string): Promise<void>;
}

export interface NavigationPolicyWiring {
  targetUrl: string;
  opener: ExternalOpener;
  presenter: DialogPresenter;
  maxRetries?: number;
  // Optional telemetry. When undefined the policy subscribes to exactly the
  // todo 2/3 event set: no `did-navigate` listener and no record calls.
  diagnostics?: DiagnosticRecorder;
}

// Installs the main-window policy on live webContents: unexpected
// navigations/redirects are cancelled (+ external delegation), and a
// finished load off the TV route or a main-frame load failure enters the
// bounded bilingual recovery. A re-entrancy guard keeps concurrent load
// events from stacking dialogs.
export function installNavigationPolicy(
  contents: NavigationPolicyContents,
  wiring: NavigationPolicyWiring,
): void {
  const diagnostics = wiring.diagnostics;
  const record =
    diagnostics === undefined
      ? undefined
      : (input: DiagnosticInput): void => {
          diagnostics.record(input);
        };
  const redirectTarget = (event: NavigationEvent, url: string): void => {
    handleMainNavigation(wiring.opener, event, url);
  };
  contents.on("will-navigate", redirectTarget);
  contents.on("will-redirect", redirectTarget);
  if (record !== undefined) {
    // Committed main-frame navigation: the origin is the only URL-derived
    // value ever recorded (the sink re-normalises it anyway).
    contents.on("did-navigate", (_event, url) => {
      record({ event: "navigation-committed", origin: url });
    });
  }
  let recovering = false;
  // A failed main-frame load is followed by did-finish-load for Chromium's
  // error page under the SAME URL. That commit must not enter recovery a
  // second time: the failure recovery already covers it. The flag is
  // consumed by the first same-URL finish, so a later genuine load of the
  // same URL is still classified normally.
  let lastFailureUrl: string | null = null;
  const enterRecovery = (kind: RouteFailureKind, failedUrl: string): void => {
    if (recovering) {
      return;
    }
    recovering = true;
    void recoverTvRoute({
      kind,
      failedUrl,
      targetUrl: wiring.targetUrl,
      maxRetries: wiring.maxRetries,
      presenter: wiring.presenter,
      opener: wiring.opener,
      reload: () =>
        contents.loadURL(wiring.targetUrl).then(() => contents.getURL()),
    }).finally(() => {
      recovering = false;
    });
  };
  contents.on("did-finish-load", () => {
    const current = contents.getURL();
    if (lastFailureUrl !== null) {
      const failedUrl = lastFailureUrl;
      lastFailureUrl = null;
      if (current === failedUrl) {
        // Chromium's error page for the failed load: not a real finish.
        return;
      }
    }
    record?.({ event: "load-finished", origin: current });
    const outcome = classifyTvRouteUrl(current);
    if (outcome !== "ok") {
      enterRecovery(outcome, current);
    }
  });
  contents.on(
    "did-fail-load",
    (_event, errorCode, _errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        record?.({
          event: "load-failed",
          errorCode,
          origin: validatedUrl,
        });
        lastFailureUrl = validatedUrl;
        enterRecovery("load-failed", validatedUrl);
      }
    },
  );
}
