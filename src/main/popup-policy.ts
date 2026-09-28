// Child-popup policy: which window.open destinations may become an
// app-owned child window, and what that child may then do.
//
// ALLOWLIST: only explicit authentication origins may become children —
// https://accounts.google.com and https://accounts.youtube.com (exact https
// origins; the list is injectable so tests substitute local fixture
// origins). Matching is on exact URL origin, so opaque origins (javascript:,
// data:, file:, custom schemes — all "null") can never match and malformed
// URLs throw before any comparison.
//
// ALLOWED CHILDREN inherit the opener's session/partition: the
// overrideBrowserWindowOptions returned for an allowed popup deliberately
// contain NO partition key. They DO pin contextIsolation:true,
// sandbox:true, nodeIntegration:false explicitly (the opener's values), so a
// child can never gain IPC/Node capability even if defaults change; the
// inherited preload stays the marker-only one.
//
// EVERY OTHER https: destination is delegated to the injected openExternal
// (production: shell.openExternal) with { action: "deny" } and NO child
// window — so window.opener never exists for untrusted origins. Non-https
// targets are denied with no external call.
//
// CHILD LIFECYCLE: did-create-window attaches a navigation guard so the
// child may only stay within the auth origins + youtube.com hosts; on
// violation the child is closed and (for valid https:) delegated
// externally.

import type { DiagnosticRecorder } from "./diagnostics.ts";
import { isYoutubeHost } from "./navigation-policy.ts";
import type { ExternalOpener } from "./navigation-policy.ts";

export const DEFAULT_AUTH_ORIGINS: readonly string[] = [
  "https://accounts.google.com",
  "https://accounts.youtube.com",
];

export type PopupDecision = "allow-child" | "open-external" | "deny";

export type ChildNavigationDecision =
  "stay" | "close-and-external" | "close-silently";

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

// Pure popup-destination decision. Exact-origin allowlist match first (any
// scheme the allowlist names — production entries are https:); every other
// valid https: destination goes external; non-https and malformed input are
// denied with no external call.
export function decidePopupDestination(
  rawUrl: string,
  authOrigins: readonly string[] = DEFAULT_AUTH_ORIGINS,
): PopupDecision {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) {
    return "deny";
  }
  if (authOrigins.includes(parsed.origin)) {
    return "allow-child";
  }
  if (parsed.protocol !== "https:") {
    return "deny";
  }
  return "open-external";
}

// Pure child-navigation decision for an already-created allowed child: it
// may stay within the auth origins + youtube.com hosts (https only);
// violations close it, delegating externally only for valid https: URLs.
export function decideChildNavigation(
  rawUrl: string,
  authOrigins: readonly string[] = DEFAULT_AUTH_ORIGINS,
): ChildNavigationDecision {
  const parsed = parseUrl(rawUrl);
  if (parsed === null) {
    return "close-silently";
  }
  if (authOrigins.includes(parsed.origin)) {
    return "stay";
  }
  if (parsed.protocol !== "https:") {
    return "close-silently";
  }
  if (isYoutubeHost(parsed.hostname)) {
    return "stay";
  }
  return "close-and-external";
}

export interface ChildWindowHandle {
  close(): void;
}

export interface ChildWindowContents {
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
}

export interface CreatedChildWindow extends ChildWindowHandle {
  webContents: ChildWindowContents;
  // Real BrowserWindows emit "closed"; optional so structural test fakes
  // without an emitter stay valid.
  on?(event: "closed", listener: () => void): unknown;
}

// Override options for allowed children. SECURITY INVARIANT: no partition
// key — the child inherits the opener's persistent session exactly. The
// three flags mirror the opener's secure webPreferences explicitly.
export function childWindowOverrides(): {
  contextIsolation: boolean;
  sandbox: boolean;
  nodeIntegration: boolean;
} {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
}

export interface WindowOpenResult {
  action: "allow" | "deny";
  overrideBrowserWindowOptions?: Record<string, boolean>;
}

export interface PopupPolicyWiring {
  opener: ExternalOpener;
  authOrigins?: readonly string[];
  // Optional telemetry. When undefined no open/close records are emitted and
  // no "closed" listener is attached to children.
  diagnostics?: DiagnosticRecorder;
}

// Handles one setWindowOpenHandler call: allowed auth origins become an
// inherited-session child; every other https: URL delegates externally and
// denies; the rest deny silently. Never creates a window for untrusted
// origins, so window.opener exists only inside the allowlisted child flow.
export function handleWindowOpen(
  wiring: PopupPolicyWiring,
  details: { url: string },
): WindowOpenResult {
  const authOrigins = wiring.authOrigins ?? DEFAULT_AUTH_ORIGINS;
  const decision = decidePopupDestination(details.url, authOrigins);
  if (decision === "allow-child") {
    wiring.diagnostics?.record({
      event: "auth-window-opened",
      origin: details.url,
      windowKind: "auth",
    });
    return {
      action: "allow",
      overrideBrowserWindowOptions: { ...childWindowOverrides() },
    };
  }
  if (decision === "open-external") {
    void wiring.opener.openExternal(details.url);
  }
  return { action: "deny" };
}

// Attaches the stay-or-close navigation guard to an allowed child. Returns
// the decision for the triggering URL so tests can assert it directly.
export function handleChildNavigation(
  wiring: PopupPolicyWiring,
  child: ChildWindowHandle,
  event: { preventDefault(): void },
  rawUrl: string,
): ChildNavigationDecision {
  const authOrigins = wiring.authOrigins ?? DEFAULT_AUTH_ORIGINS;
  const decision = decideChildNavigation(rawUrl, authOrigins);
  if (decision === "stay") {
    return decision;
  }
  event.preventDefault();
  child.close();
  if (decision === "close-and-external") {
    void wiring.opener.openExternal(rawUrl);
  }
  return decision;
}

// Structural host surface for wiring (kept structural so tests install
// against fakes and production passes real WebContents).
export interface PopupPolicyHost {
  setWindowOpenHandler(
    handler: (details: { url: string }) => WindowOpenResult,
  ): void;
  on(
    event: "did-create-window",
    listener: (child: CreatedChildWindow) => void,
  ): unknown;
}

export function installPopupPolicy(
  host: PopupPolicyHost,
  wiring: PopupPolicyWiring,
): void {
  host.setWindowOpenHandler((details) => handleWindowOpen(wiring, details));
  host.on("did-create-window", (child) => {
    const diagnostics = wiring.diagnostics;
    if (diagnostics !== undefined && typeof child.on === "function") {
      child.on("closed", () => {
        diagnostics.record({ event: "auth-window-closed", windowKind: "auth" });
      });
    }
    const guard = (event: { preventDefault(): void }, url: string): void => {
      handleChildNavigation(wiring, child, event, url);
    };
    child.webContents.on("will-navigate", guard);
    child.webContents.on("will-redirect", guard);
  });
}
