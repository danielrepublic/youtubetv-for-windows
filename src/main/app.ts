import type { DiagnosticRecorder } from "./diagnostics.ts";
import type { DialogPresenter } from "./dialogs.ts";
import {
  installNavigationPolicy,
  type ExternalOpener,
  type NavigationPolicyContents,
} from "./navigation-policy.ts";
import { installPopupPolicy, type PopupPolicyHost } from "./popup-policy.ts";
import { activateIdentityPolicy } from "./session.ts";
import type { IdentityPolicySession } from "./session.ts";
import { assertIdentityPolicy } from "./user-agent.ts";
import { buildWindowOptions } from "./window.ts";
import type { SecureWindowOptions } from "./window.ts";

// Production navigation target. The test seam is dependency injection of the
// runtime and the target URL (see startHost): the shipped entry below always
// passes this constant, and no environment, CLI, or config override exists.
export const YOUTUBE_TV_URL = "https://www.youtube.com/tv";

export interface HostWebContents {
  on(
    event: string,
    listener: (
      event: { preventDefault(): void },
      input: { key?: string; type?: string },
    ) => void,
  ): unknown;
}

export interface HostWindow {
  loadURL(url: string): Promise<void>;
  webContents: HostWebContents;
  setFullScreen(fullscreen: boolean): void;
  isFullScreen(): boolean;
}

export interface HostRuntime {
  session: IdentityPolicySession;
  appPath: string;
  createWindow(options: SecureWindowOptions): HostWindow;
}

export interface StartedHost {
  window: HostWindow;
  userAgent: string;
  headerInterceptionActive: boolean;
}

// Policy dependencies injected by the production entry (or the fixture
// host): the OS-browser opener and the route-failure dialog presenter plus
// the popup allowlist. Kept injected (never imported from Electron here) so
// startHost stays unit-testable and tests can record every delegation.
export interface HostPolicyDeps {
  opener: ExternalOpener;
  presenter: DialogPresenter;
  authOrigins?: readonly string[];
  // Optional and undefined by default: when absent, NO diagnostics listeners
  // are attached and the host behaves exactly as without diagnostics. The
  // production entry passes a sink here ONLY when the documented sentinel
  // file enabled diagnostics (see diagnostics.ts).
  diagnostics?: DiagnosticRecorder;
}

// F11 is the only host-level key binding: it toggles fullscreen. Esc is
// deliberately never intercepted, so YouTube TV keeps its own Escape
// behavior. The keyDown gate keeps one physical press to one toggle, since
// before-input-event fires for both keyDown and keyUp.
export function attachFullscreenToggle(window: HostWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F11" && input.type === "keyDown") {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    }
  });
}

// Composition root: activate the fixed identity first, assert it, then create
// the (validated,
// fullscreen, sandboxed) window, install the navigation + popup policies
// when policy dependencies are provided, and load the target exactly once.
// The target never loads unless the identity policy activated successfully.
//
export async function startHost(
  runtime: HostRuntime,
  targetUrl: string,
  policies?: HostPolicyDeps,
): Promise<StartedHost> {
  const evidence = activateIdentityPolicy(runtime.session);
  assertIdentityPolicy(evidence.userAgent);
  const options = buildWindowOptions(runtime.appPath);
  const window = runtime.createWindow(options);
  policies?.diagnostics?.record({
    event: "window-created",
    windowKind: "main",
  });
  attachFullscreenToggle(window);
  if (policies !== undefined) {
    installNavigationPolicy(
      window.webContents as unknown as NavigationPolicyContents,
      {
        targetUrl,
        opener: policies.opener,
        presenter: policies.presenter,
        diagnostics: policies.diagnostics,
      },
    );
    installPopupPolicy(window.webContents as unknown as PopupPolicyHost, {
      opener: policies.opener,
      authOrigins: policies.authOrigins,
      diagnostics: policies.diagnostics,
    });
  }
  await window.loadURL(targetUrl);
  return {
    window,
    userAgent: evidence.userAgent,
    headerInterceptionActive: evidence.headerInterceptionActive,
  };
}
