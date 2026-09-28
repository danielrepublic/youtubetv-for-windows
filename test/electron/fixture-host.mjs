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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHost } from "../../dist/main/app.js";
import { IDENTITY_PARTITION } from "../../dist/main/session.js";
import { assertIdentityPolicy } from "../../dist/main/user-agent.js";
import { buildWindowOptions } from "../../dist/main/window.js";

const rawArguments = process.argv.slice(1);
const targetUrl = rawArguments.find((entry) => entry.startsWith("http"));
const mutatedMode = rawArguments.includes("--mutated");
const visibleMode = rawArguments.includes("--show");

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
  } else {
    await runHostScenario();
  }
  report({ event: "done" });
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
