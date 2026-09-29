// Test-only Electron main script for the secure-host integration tests.
//
// It imports the COMPILED production modules from dist/main/ (the
// `pretest:electron` hook builds them before the electron chain runs), drives
// the real host composition root against a fixture URL passed by the Node
// test process, and reports a JSON-lines trace on stdout. It is not a suite
// file (no .test.mjs suffix), so the chain runner never picks it up.
//
// Modes:
//   electron fixture-host.mjs <fixtureUrl>   full host scenario
//   electron fixture-host.mjs --mutated       mutated-identity rejection gate
// Every other argv entry (including a hostile --user-agent switch or env
// var, which the host must ignore) is deliberately never read.

import { app, BrowserWindow, session } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHost } from "../../dist/main/app.js";
import { createProfileDiagnostics } from "../../dist/main/diagnostics.js";
import { IDENTITY_PARTITION } from "../../dist/main/session.js";
import { assertIdentityPolicy } from "../../dist/main/user-agent.js";
import { buildWindowOptions } from "../../dist/main/window.js";
import { installNavigationPolicy } from "../../dist/main/navigation-policy.js";
import { installPopupPolicy } from "../../dist/main/popup-policy.js";
import { activateProfileDirectory } from "../../dist/main/profile-path.js";

const rawArguments = process.argv.slice(1);
const targetUrl = rawArguments.find((entry) => entry.startsWith("http"));
const mutatedMode = rawArguments.includes("--mutated");
const visibleMode = rawArguments.includes("--show");

function paramValue(name) {
  const prefix = `--${name}=`;
  const found = rawArguments.find((entry) => entry.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function paramList(name) {
  const prefix = `--${name}=`;
  return rawArguments
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
}

function scenarioName() {
  return paramValue("scenario");
}

function repositoryRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function report(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function runMutatedGate() {
  let rejected = false;
  try {
    assertIdentityPolicy("evil-mutated-user-agent");
  } catch {
    rejected = true;
  }
  report({ event: "mutation-rejected", rejected });
  // No window is created and no URL is ever loaded: a mutated identity must
  // not produce a single request at the fixture server.
}

async function runHostScenario() {
  if (targetUrl === undefined) {
    throw new Error("fixture-host: no fixture http(s) URL found in argv");
  }
  const electronSession = session.fromPartition(IDENTITY_PARTITION);
  // Repository root derived from this file's location. A file-argument
  // launch reports app.getAppPath() as the entry's own directory
  // (test/electron/), while production (project root / resources/app) sees
  // the real application root; anchoring here keeps the fixture on the exact
  // production code path (buildWindowOptions -> resolvePreloadPath).
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const probeOptions = buildWindowOptions(repositoryRoot);
  report({
    event: "environment",
    appPath: app.getAppPath(),
    repositoryRoot,
    preloadPath: probeOptions.webPreferences.preload,
    preloadExists: fs.existsSync(probeOptions.webPreferences.preload),
  });
  const host = await startHost(
    {
      session: electronSession,
      appPath: repositoryRoot,
      createWindow: (options) =>
        new BrowserWindow({ ...options, show: visibleMode }),
    },
    targetUrl,
  );
  const window = host.window;
  report({
    event: "policy",
    userAgent: host.userAgent,
    headerInterceptionActive: host.headerInterceptionActive,
    sessionUserAgent: electronSession.getUserAgent(),
  });
  const initialFullscreen = window.isFullScreen();
  report({ event: "fullscreen-initial", isFullScreen: initialFullscreen });

  const observedKeys = [];
  window.webContents.on("before-input-event", (_event, input) => {
    observedKeys.push(`${input.type}:${input.key}`);
  });
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
  await sleep(600);
  const afterFirstF11 = window.isFullScreen();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
  await sleep(600);
  const afterSecondF11 = window.isFullScreen();

  // Esc is YouTube TV's own key: the host must never intercept it, so a
  // fullscreen window stays fullscreen. (What YouTube's page itself does
  // with Esc is page behavior and out of host scope.)
  if (!afterSecondF11) {
    window.setFullScreen(true);
    await sleep(400);
  }
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  await sleep(600);
  const afterEsc = window.isFullScreen();
  report({
    event: "keys",
    observedKeys,
    afterFirstF11,
    afterSecondF11,
    afterEsc,
  });

  const probe = await window.webContents.executeJavaScript(
    "({ ua: navigator.userAgent, marker: window.__youtubeTvHost ?? null, " +
      "markerFrozen: window.__youtubeTvHost ? Object.isFrozen(window.__youtubeTvHost) : false, " +
      "domWitness: document.documentElement.getAttribute('data-youtube-tv-host'), " +
      "requireType: typeof require, processType: typeof process })",
  );
  report({ event: "probe", ...probe });
}

async function main() {
  if (mutatedMode) {
    await runMutatedGate();
  } else if (scenarioName() !== undefined) {
    await runPolicyScenario(scenarioName());
  } else {
    await runHostScenario();
  }
  report({ event: "done" });
}

// ---- Todo-3 policy scenarios -------------------------------------------
//
// Each scenario drives the COMPILED production policy modules against real
// BrowserWindows and local fixture URLs, with a recording openExternal and
// a scripted dialog presenter (no human, no real shell, no network beyond
// 127.0.0.1). Passive event taps record which Electron events fired so the
// node-side suite can assert the mechanism, not just the outcome.
//
// Scenarios (selected by --scenario=NAME, params as --name=value):
//   nav          --page-url, repeatable --go, --auth-origin (optional)
//   popup        --page-url, --auth-origin, --popup-url, --child-go (optional),
//                --cookie-name/--cookie-value (optional, allow path only)
//   route        --page-url (off-route), --dialog-script (csv of indexes)
//   loadfail     --page-url (unreachable), --dialog-script
//   profile      --profile-base, --mode=set|get, --cookie-url,
//                --cookie-name, --cookie-value
//   diagnostics  --page-url (with secret query), --diagnostics-base,
//                --auth-origin, --popup-url, --fail-url (optional),
//                --dialog-script (optional)

function createPolicyRecorders() {
  const externalCalls = [];
  const dialogOptions = [];
  return {
    externalCalls,
    dialogOptions,
    opener: {
      openExternal: (url) => {
        externalCalls.push(url);
      },
    },
    presenterFromScript: (script) => ({
      showMessageBox: async (options) => {
        dialogOptions.push(options);
        const next = script.length > 0 ? script.shift() : 2;
        return { response: next };
      },
    }),
  };
}

function parseDialogScript() {
  const raw = paramValue("dialog-script");
  if (raw === undefined || raw === "") {
    return [2];
  }
  return raw.split(",").map((entry) => Number(entry));
}

function tapPolicyEvents(contents, navigationEvents) {
  contents.on("will-navigate", (_event, url) => {
    navigationEvents.push(`will-navigate:${url}`);
  });
  contents.on("will-redirect", (_event, url) => {
    navigationEvents.push(`will-redirect:${url}`);
  });
  contents.on("did-finish-load", () => {
    navigationEvents.push("did-finish-load");
  });
  contents.on(
    "did-fail-load",
    (_event, code, _description, url, isMainFrame) => {
      navigationEvents.push(`did-fail-load:${code}:${isMainFrame}:${url}`);
    },
  );
}

async function runPolicyScenario(name) {
  if (name === "nav") {
    await runNavScenario();
  } else if (name === "popup") {
    await runPopupScenario();
  } else if (name === "route") {
    await runRouteScenario();
  } else if (name === "loadfail") {
    await runLoadfailScenario();
  } else if (name === "profile") {
    await runProfileScenario();
  } else if (name === "diagnostics") {
    await runDiagnosticsScenario();
  } else {
    throw new Error(`fixture-host: unknown scenario ${name}`);
  }
}

// Unexpected main-window navigation: the fixture page is loaded first, the
// production navigation policy is installed, then each --go target is driven
// through renderer-initiated location.href (the will-navigate path).
async function runNavScenario() {
  const pageUrl = paramValue("page-url");
  const goUrls = paramList("go");
  if (pageUrl === undefined) {
    throw new Error("fixture-host nav: --page-url is required");
  }
  const repositoryRoot = repositoryRootFromHere();
  const recorders = createPolicyRecorders();
  const navigationEvents = [];
  const window = new BrowserWindow({
    ...buildWindowOptions(repositoryRoot),
    show: false,
  });
  await window.loadURL(pageUrl);
  tapPolicyEvents(window.webContents, navigationEvents);
  installNavigationPolicy(window.webContents, {
    targetUrl: pageUrl,
    opener: recorders.opener,
    presenter: recorders.presenterFromScript(parseDialogScript()),
  });
  const results = [];
  for (const go of goUrls) {
    const externalBefore = recorders.externalCalls.length;
    const urlBefore = window.webContents.getURL();
    await window.webContents.executeJavaScript(
      `location.href = ${JSON.stringify(go)}`,
    );
    await sleep(900);
    results.push({
      go,
      urlBefore,
      urlAfter: window.webContents.getURL(),
      newExternal: recorders.externalCalls.slice(externalBefore),
    });
  }
  report({
    event: "nav-results",
    results,
    externalCalls: recorders.externalCalls,
    navigationEvents,
    dialogOptions: recorders.dialogOptions,
  });
}

// Popup lifecycle: window.open through the production popup policy with the
// injected local auth origin. Reports child creation, session identity,
// cookie visibility, renderer privilege, and external delegation.
async function runPopupScenario() {
  const pageUrl = paramValue("page-url");
  const authOrigin = paramValue("auth-origin");
  const popupUrl = paramValue("popup-url");
  const childGo = paramValue("child-go");
  const cookieName = paramValue("cookie-name");
  const cookieValue = paramValue("cookie-value");
  if (
    pageUrl === undefined ||
    authOrigin === undefined ||
    popupUrl === undefined
  ) {
    throw new Error(
      "fixture-host popup: --page-url, --auth-origin and --popup-url are required",
    );
  }
  const repositoryRoot = repositoryRootFromHere();
  const recorders = createPolicyRecorders();
  const navigationEvents = [];
  const electronSession = session.fromPartition(IDENTITY_PARTITION);
  const window = new BrowserWindow({
    ...buildWindowOptions(repositoryRoot),
    show: false,
  });
  await window.loadURL(pageUrl);
  tapPolicyEvents(window.webContents, navigationEvents);
  let createdWindows = 0;
  window.webContents.on("did-create-window", () => {
    createdWindows += 1;
  });
  installPopupPolicy(window.webContents, {
    opener: recorders.opener,
    authOrigins: [authOrigin],
  });
  if (cookieName !== undefined && cookieValue !== undefined) {
    await electronSession.cookies.set({
      url: popupUrl,
      name: cookieName,
      value: cookieValue,
      // A persistent cookie: session cookies never reach the disk store,
      // so without an expiry the sharing probe would still pass in-process
      // while teaching nothing about persistence.
      expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365,
    });
  }
  // window.open returns a WindowProxy, which executeJavaScript cannot
  // serialize back; drive it for side effects only and resolve undefined.
  const openOutcome = await window.webContents.executeJavaScript(
    `(function () { const child = window.open(${JSON.stringify(popupUrl)}, "_blank"); return { returnedNull: child === null, closed: child !== null && child.closed }; })()`,
  );
  await sleep(2000);
  // Popups arrive as top-level windows (getChildWindows stays empty even
  // though did-create-window fires on the opener), so the child is
  // identified as any live window beyond the opener itself.
  const childWindows = window.getChildWindows();
  const allWindows = BrowserWindow.getAllWindows().filter(
    (entry) => entry !== window && !entry.isDestroyed(),
  );
  const child = allWindows[0];
  let sessionSame = false;
  let childUrl = null;
  let privilege = null;
  let cookie = null;
  if (child !== undefined) {
    sessionSame = child.webContents.session === electronSession;
    childUrl = child.webContents.getURL();
    tapPolicyEvents(child.webContents, navigationEvents);
    privilege = await child.webContents.executeJavaScript(
      "({ requireType: typeof require, processType: typeof process })",
    );
    cookie = await child.webContents.executeJavaScript("document.cookie");
  }
  report({
    event: "popup-result",
    childCount: childWindows.length,
    popupCount: allWindows.length,
    createdWindows,
    openOutcome,
    sessionSame,
    childUrl,
    privilege,
    cookie,
    externalCalls: recorders.externalCalls,
    navigationEvents,
  });
  // Optional second phase: redirect the allowed child somewhere disallowed.
  // The guard must close it and delegate externally for valid https:.
  if (childGo !== undefined && child !== undefined && !child.isDestroyed()) {
    const externalBefore = recorders.externalCalls.length;
    await child.webContents.executeJavaScript(
      `location.href = ${JSON.stringify(childGo)}`,
    );
    await sleep(1500);
    report({
      event: "child-redirect",
      destroyed: child.isDestroyed(),
      remainingPopups: BrowserWindow.getAllWindows().filter(
        (entry) => entry !== window && !entry.isDestroyed(),
      ).length,
      newExternal: recorders.externalCalls.slice(externalBefore),
      navigationEvents,
    });
  }
}

// Redirected-away TV route: loads an off-route page with the navigation
// policy installed so did-finish-load enters the bounded bilingual
// recovery driven by the scripted dialog. --target-url selects the recovery
// reload target (tests pass a local page so retries re-land off-route and
// no live network is touched; production passes the TV URL).
async function runRouteScenario() {
  const pageUrl = paramValue("page-url");
  const targetUrl = paramValue("target-url") ?? "https://www.youtube.com/tv";
  if (pageUrl === undefined) {
    throw new Error("fixture-host route: --page-url is required");
  }
  const repositoryRoot = repositoryRootFromHere();
  const recorders = createPolicyRecorders();
  const navigationEvents = [];
  const window = new BrowserWindow({
    ...buildWindowOptions(repositoryRoot),
    show: false,
  });
  tapPolicyEvents(window.webContents, navigationEvents);
  installNavigationPolicy(window.webContents, {
    targetUrl,
    opener: recorders.opener,
    presenter: recorders.presenterFromScript(parseDialogScript()),
  });
  const loadError = await window.loadURL(pageUrl).then(
    () => null,
    (error) => String(error?.message ?? error),
  );
  await sleep(2500);
  report({
    event: "route-result",
    loadError,
    currentUrl: window.webContents.isDestroyed()
      ? null
      : window.webContents.getURL(),
    dialogOptions: recorders.dialogOptions,
    externalCalls: recorders.externalCalls,
    navigationEvents,
  });
}

// Load failure: the target is unreachable, so the main-frame did-fail-load
// enters the same bilingual recovery. --target-url selects the recovery
// reload target (see runRouteScenario).
async function runLoadfailScenario() {
  const pageUrl = paramValue("page-url");
  const targetUrl = paramValue("target-url") ?? "https://www.youtube.com/tv";
  if (pageUrl === undefined) {
    throw new Error("fixture-host loadfail: --page-url is required");
  }
  const repositoryRoot = repositoryRootFromHere();
  const recorders = createPolicyRecorders();
  const navigationEvents = [];
  const window = new BrowserWindow({
    ...buildWindowOptions(repositoryRoot),
    show: false,
  });
  tapPolicyEvents(window.webContents, navigationEvents);
  installNavigationPolicy(window.webContents, {
    targetUrl,
    opener: recorders.opener,
    presenter: recorders.presenterFromScript(parseDialogScript()),
  });
  const loadError = await window.loadURL(pageUrl).then(
    () => null,
    (error) => String(error?.message ?? error),
  );
  await sleep(2500);
  report({
    event: "loadfail-result",
    loadError,
    dialogOptions: recorders.dialogOptions,
    externalCalls: recorders.externalCalls,
    navigationEvents,
  });
}

// Persistent profile: activates the production profile path (real
// app.setPath) before opening the persistent session, then sets or reads a
// cookie. The node suite spawns this twice against the SAME base directory
// to prove persistence, and once against a file path to prove fallback.
async function runProfileScenario() {
  const profileBase = paramValue("profile-base");
  const mode = paramValue("mode") ?? "get";
  const cookieUrl = paramValue("cookie-url");
  const cookieName = paramValue("cookie-name") ?? "ytv_profile_probe";
  const cookieValue = paramValue("cookie-value") ?? "probe-value";
  if (profileBase === undefined || cookieUrl === undefined) {
    throw new Error(
      "fixture-host profile: --profile-base and --cookie-url are required",
    );
  }
  const activation = activateProfileDirectory({
    localAppDataDir: profileBase,
    appDataDir: path.join(os.tmpdir(), "ytv-profile-should-not-appear"),
    setSessionDataPath: (directory) => {
      app.setPath("sessionData", directory);
    },
  });
  report({
    event: "profile-activation",
    directory: activation.directory,
    usedFallback: activation.usedFallback,
    guidance: activation.guidance,
  });
  const electronSession = session.fromPartition(IDENTITY_PARTITION);
  if (mode === "set") {
    await electronSession.cookies.set({
      url: cookieUrl,
      name: cookieName,
      value: cookieValue,
      // Persistent across relaunch: a session cookie would never be
      // written to the profile's cookie store, even with flushStore.
      expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365,
    });
    await electronSession.cookies.flushStore();
    report({ event: "cookie-written", name: cookieName, value: cookieValue });
  } else {
    const found = await electronSession.cookies.get({
      url: cookieUrl,
      name: cookieName,
    });
    report({
      event: "cookie-read",
      name: cookieName,
      value: found.length > 0 ? found[0].value : null,
    });
  }
}

// Opt-in telemetry: drives the real startHost composition (navigation +
// popup policies plus the production diagnostics factory) against local
// fixture URLs whose paths/query strings carry secret-shaped values. The
// node suite reads the reported JSONL path and asserts the redaction
// contract; this scenario reports only file paths and counters.
async function runDiagnosticsScenario() {
  const pageUrl = paramValue("page-url");
  const diagnosticsBase = paramValue("diagnostics-base");
  const authOrigin = paramValue("auth-origin");
  const popupUrl = paramValue("popup-url");
  const failUrl = paramValue("fail-url");
  if (
    pageUrl === undefined ||
    diagnosticsBase === undefined ||
    authOrigin === undefined ||
    popupUrl === undefined
  ) {
    throw new Error(
      "fixture-host diagnostics: --page-url, --diagnostics-base, " +
        "--auth-origin and --popup-url are required",
    );
  }
  const repositoryRoot = repositoryRootFromHere();
  const activation = activateProfileDirectory({
    localAppDataDir: diagnosticsBase,
    appDataDir: path.join(os.tmpdir(), "ytv-diagnostics-should-not-appear"),
    setSessionDataPath: (directory) => {
      app.setPath("sessionData", directory);
    },
  });
  // The production factory is the single opt-in read point: sentinel file
  // <base>/youtubetv-for-windows/diagnostics/ENABLED present or absent.
  const diagnostics = createProfileDiagnostics(activation.directory);
  report({
    event: "diagnostics-mode",
    enabled: diagnostics !== null,
    filePath: diagnostics === null ? null : diagnostics.filePath,
    profileDirectory: activation.directory,
  });
  diagnostics?.record({ event: "app-ready" });
  const recorders = createPolicyRecorders();
  const electronSession = session.fromPartition(IDENTITY_PARTITION);
  const host = await startHost(
    {
      session: electronSession,
      appPath: repositoryRoot,
      createWindow: (options) => new BrowserWindow({ ...options, show: false }),
    },
    pageUrl,
    {
      opener: recorders.opener,
      presenter: recorders.presenterFromScript(parseDialogScript()),
      authOrigins: [authOrigin],
      // undefined when OFF, so the wiring adds zero diagnostics listeners.
      diagnostics: diagnostics ?? undefined,
    },
  );
  // An allowlisted popup: the policy records auth-window-opened at the
  // allow decision and auth-window-closed from the child's closed event.
  const childPromise = new Promise((resolve) => {
    host.window.webContents.on("did-create-window", (child) => {
      resolve(child);
    });
    setTimeout(() => resolve(undefined), 3000);
  });
  await host.window.webContents.executeJavaScript(
    `(function () { window.open(${JSON.stringify(popupUrl)}, "_blank"); return true; })()`,
  );
  const child = await childPromise;
  report({ event: "diagnostics-popup", childOpened: child !== undefined });
  if (child !== undefined && !child.isDestroyed()) {
    child.close();
    await sleep(1200);
  }
  // A main-frame load failure: the numeric code is the only failure datum.
  if (failUrl !== undefined) {
    await host.window.loadURL(failUrl).catch(() => null);
    await sleep(2500);
  }
  diagnostics?.record({ event: "app-quit" });
  report({
    event: "diagnostics-done",
    filePath: diagnostics === null ? null : diagnostics.filePath,
    counters: diagnostics === null ? null : diagnostics.counters,
    externalCalls: recorders.externalCalls.length,
  });
}

// No top-level await: awaiting the entry module's top-level promise blocks
// Electron's ready signal and deadlocks startup, so boot through .then().
app
  .whenReady()
  .then(() => main())
  .then(
    () => {
      app.quit();
    },
    (error) => {
      report({ event: "error", message: String(error?.message ?? error) });
      process.exitCode = 1;
      app.quit();
    },
  );
