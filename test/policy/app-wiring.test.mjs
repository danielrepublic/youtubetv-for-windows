// Unit suite for the app composition root's policy wiring: startHost must
// install the navigation + popup policies when policy dependencies are
// provided, run the injected pre-window update stage exactly once BEFORE any
// window exists, keep F11-only input handling, and leave everything
// uninstalled when no policies are passed.

import assert from "node:assert/strict";
import test from "node:test";

const { startHost } = await import("../../src/main/app.ts");

function fakeSession() {
  return {
    setUserAgentCalls: [],
    headerListeners: 0,
    setUserAgent(value) {
      this.setUserAgentCalls.push(value);
    },
    webRequest: {
      onBeforeSendHeaders: () => {
        // Counted through the closure below instead.
      },
    },
  };
}

function fakeRuntime(captures) {
  const session = fakeSession();
  let headerCount = 0;
  session.webRequest.onBeforeSendHeaders = () => {
    headerCount += 1;
  };
  return {
    session,
    get headerCount() {
      return headerCount;
    },
    appPath: "C:\\app",
    createWindow: (options) => {
      captures.options = options;
      const listeners = {};
      const window = {
        loadCalls: [],
        fullscreen: true,
        webContents: {
          on: (event, listener) => {
            listeners[event] = listeners[event] ?? [];
            listeners[event].push(listener);
            return undefined;
          },
          setWindowOpenHandler: (handler) => {
            captures.windowOpenHandler = handler;
            return undefined;
          },
        },
        loadURL: async (url) => {
          window.loadCalls.push(url);
        },
        setFullScreen: (value) => {
          window.fullscreen = value;
        },
        isFullScreen: () => window.fullscreen,
      };
      captures.listeners = listeners;
      captures.window = window;
      return window;
    },
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

test("the pre-window stage resolves before any window is created", async () => {
  const captures = {};
  const runtime = fakeRuntime(captures);
  const order = [];
  const originalCreateWindow = runtime.createWindow;
  runtime.createWindow = (options) => {
    order.push("window-created");
    return originalCreateWindow(options);
  };
  let stageCalls = 0;
  const host = await startHost(runtime, "https://www.youtube.com/tv", {
    opener: { openExternal: () => undefined },
    presenter: { showMessageBox: async () => ({ response: 1 }) },
    preWindowStage: async () => {
      stageCalls += 1;
      order.push("stage-start");
      // The fixed identity policy must already be active when the update
      // stage runs (the UA is set once, before anything else).
      assert.equal(runtime.session.setUserAgentCalls.length, 1);
      await sleep(5);
      order.push("stage-resolved");
      return { action: "launch", reason: "up-to-date" };
    },
  });
  assert.ok(host, "a launch decision must still produce the host");
  assert.equal(stageCalls, 1, "the stage runs exactly once per launch");
  assert.deepEqual(order, ["stage-start", "stage-resolved", "window-created"]);
  assert.deepEqual(captures.window.loadCalls, ["https://www.youtube.com/tv"]);
});

test("a quit decision suppresses window creation entirely", async () => {
  const captures = {};
  const runtime = fakeRuntime(captures);
  const order = [];
  const originalCreateWindow = runtime.createWindow;
  runtime.createWindow = (options) => {
    order.push("window-created");
    return originalCreateWindow(options);
  };
  const host = await startHost(runtime, "https://www.youtube.com/tv", {
    opener: { openExternal: () => undefined },
    presenter: { showMessageBox: async () => ({ response: 1 }) },
    preWindowStage: async () => {
      order.push("stage-quit");
      return { action: "quit", reason: "update-ready" };
    },
  });
  assert.equal(
    host,
    null,
    "no host is started when the installer owns the launch",
  );
  assert.deepEqual(order, ["stage-quit"]);
  assert.equal(captures.window, undefined, "no BrowserWindow may be created");
  assert.equal(captures.windowOpenHandler, undefined);
  assert.equal(captures.listeners, undefined);
});

test("startHost installs both policies and loads the target once", async () => {
  const captures = {};
  const runtime = fakeRuntime(captures);
  const external = [];
  const dialogs = [];
  const host = await startHost(runtime, "https://www.youtube.com/tv", {
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    presenter: {
      showMessageBox: async (options) => {
        dialogs.push(options);
        return { response: 2 };
      },
    },
    authOrigins: ["https://accounts.google.com"],
  });
  assert.equal(host.userAgent.includes("Leanback"), true);
  assert.equal(host.headerInterceptionActive, true);
  // Navigation policy: will-navigate + will-redirect + load-event handlers.
  assert.ok(captures.listeners["will-navigate"]?.length === 1);
  assert.ok(captures.listeners["will-redirect"]?.length === 1);
  assert.ok(captures.listeners["did-finish-load"]?.length === 1);
  assert.ok(captures.listeners["did-fail-load"]?.length === 1);
  // Popup policy: a window-open handler is installed.
  assert.equal(typeof captures.windowOpenHandler, "function");
  // Fullscreen toggle from todo 2 is still wired exactly once.
  assert.ok(captures.listeners["before-input-event"]?.length === 1);
  // The target loads exactly once.
  assert.deepEqual(captures.window.loadCalls, ["https://www.youtube.com/tv"]);
  // The installed handlers behave: external navigation delegates out.
  let cancelled = false;
  captures.listeners["will-navigate"][0](
    {
      preventDefault: () => {
        cancelled = true;
      },
    },
    "https://example.com/",
  );
  assert.equal(cancelled, true);
  assert.deepEqual(external, ["https://example.com/"]);
  // The installed popup handler allows the injected auth origin.
  const allowed = captures.windowOpenHandler({
    url: "https://accounts.google.com/x",
  });
  assert.equal(allowed.action, "allow");
  assert.ok(!("partition" in (allowed.overrideBrowserWindowOptions ?? {})));
});

test("startHost without policies preserves the todo-2 bare behavior", async () => {
  const captures = {};
  const runtime = fakeRuntime(captures);
  await startHost(runtime, "https://www.youtube.com/tv");
  assert.equal(captures.windowOpenHandler, undefined);
  assert.equal(captures.listeners["will-navigate"], undefined);
  assert.deepEqual(captures.window.loadCalls, ["https://www.youtube.com/tv"]);
});

test("attachFullscreenToggle still toggles on F11 keyDown only", async () => {
  const captures = {};
  const runtime = fakeRuntime(captures);
  await startHost(runtime, "https://www.youtube.com/tv");
  const listeners = captures.listeners["before-input-event"];
  assert.equal(listeners.length, 1);
  const handler = listeners[0];
  let prevented = 0;
  const event = () => ({
    preventDefault: () => {
      prevented += 1;
    },
  });
  handler(event(), { key: "F11", type: "keyDown" });
  assert.equal(captures.window.fullscreen, false);
  handler(event(), { key: "F11", type: "keyUp" });
  assert.equal(captures.window.fullscreen, false);
  handler(event(), { key: "Escape", type: "keyDown" });
  assert.equal(captures.window.fullscreen, false);
  assert.equal(prevented, 1);
});
