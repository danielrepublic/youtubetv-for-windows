import path from "node:path";
import { IDENTITY_PARTITION } from "./session.ts";

export interface SecureWebPreferences {
  contextIsolation: boolean;
  sandbox: boolean;
  nodeIntegration: boolean;
  partition: string;
  preload: string;
  spellcheck: boolean;
}

export interface SecureWindowOptions {
  fullscreen: boolean;
  show: boolean;
  webPreferences: SecureWebPreferences;
}

// Resolves the sandboxed preload entry against the application path so the
// same value works unpackaged (repository root) and packaged
// (resources/app): the build always emits dist/preload/preload.js.
export function resolvePreloadPath(appPath: string): string {
  return path.join(appPath, "dist", "preload", "preload.js");
}

// Fail-closed gate: any window granting Node access, disabling the sandbox
// or context isolation, or loading no preload script is rejected. The
// production window is built through buildWindowOptions, which calls this
// before returning, so an insecure configuration can never be constructed
// through the production path.
export function validateWebPreferences(prefs: SecureWebPreferences): void {
  if (prefs.nodeIntegration !== false) {
    throw new Error("Insecure webPreferences: nodeIntegration must be false.");
  }
  if (prefs.contextIsolation !== true) {
    throw new Error("Insecure webPreferences: contextIsolation must be true.");
  }
  if (prefs.sandbox !== true) {
    throw new Error("Insecure webPreferences: sandbox must be true.");
  }
  if (prefs.partition !== IDENTITY_PARTITION) {
    throw new Error(
      "Insecure webPreferences: the window must share the persistent " +
        "identity session partition.",
    );
  }
  if (typeof prefs.preload !== "string" || prefs.preload.length === 0) {
    throw new Error(
      "Insecure webPreferences: a preload script path is required.",
    );
  }
}

// Production BrowserWindow configuration: fullscreen TV host with secure
// webPreferences. The optional show override exists only so integration tests
// can keep windows hidden where the assertions stay truthful; production
// always uses the default (visible).
export function buildWindowOptions(
  appPath: string,
  overrides?: { show?: boolean },
): SecureWindowOptions {
  const options: SecureWindowOptions = {
    fullscreen: true,
    show: overrides?.show ?? true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: IDENTITY_PARTITION,
      preload: resolvePreloadPath(appPath),
      spellcheck: false,
    },
  };
  validateWebPreferences(options.webPreferences);
  return options;
}
