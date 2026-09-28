// Wiring suite: the navigation and popup policies emit the documented
// lifecycle events when (and ONLY when) a diagnostics recorder is provided,
// and adding the recorder never alters policy decisions.

import assert from "node:assert/strict";
import test from "node:test";

const { installNavigationPolicy } =
  await import("../../src/main/navigation-policy.ts");
const { installPopupPolicy } = await import("../../src/main/popup-policy.ts");

function fakeContents() {
  const listeners = {};
  const subscribed = [];
  const contents = {
    listeners,
    subscribed,
    url: "about:blank",
    on(event, listener) {
      subscribed.push(event);
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(listener);
      return undefined;
    },
    getURL: () => contents.url,
    loadURL: async () => undefined,
  };
  return contents;
}

function recorder() {
  const records = [];
  return {
    records,
    record: (input) => {
      records.push(input);
    },
  };
}

const OPENER = { openExternal: () => undefined };
const PRESENTER = { showMessageBox: async () => ({ response: 2 }) };

test("navigation policy records commits and load outcomes when wired", () => {
  const contents = fakeContents();
  const diagnostics = recorder();
  installNavigationPolicy(contents, {
    targetUrl: "https://www.youtube.com/tv",
    opener: OPENER,
    presenter: PRESENTER,
    diagnostics,
  });
  assert.ok(contents.subscribed.includes("did-navigate"));
  const navigate = contents.listeners["did-navigate"][0];
  navigate({}, "https://www.youtube.com/tv?token=ZZSECRETZZ#frag");
  contents.url = "https://www.youtube.com/tv";
  const finish = contents.listeners["did-finish-load"][0];
  finish();
  const fail = contents.listeners["did-fail-load"][0];
  fail(
    {},
    -105,
    "NAME_NOT_RESOLVED",
    "https://www.youtube.com/tv?token=ZZSECRETZZ",
    true,
  );
  // Subframe failures are noise and must not enter telemetry.
  fail({}, -3, "ABORTED", "https://www.youtube.com/frame", false);
  assert.deepEqual(
    diagnostics.records.map((entry) => entry.event),
    ["navigation-committed", "load-finished", "load-failed"],
  );
  assert.equal(
    diagnostics.records[0].origin,
    "https://www.youtube.com/tv?token=ZZSECRETZZ#frag",
  );
  assert.equal(diagnostics.records[2].errorCode, -105);
});

test("the error-page finish after a failure is not reported as a load-finish", () => {
  const contents = fakeContents();
  const diagnostics = recorder();
  installNavigationPolicy(contents, {
    targetUrl: "https://www.youtube.com/tv",
    opener: OPENER,
    presenter: PRESENTER,
    diagnostics,
  });
  const failedUrl = "https://www.youtube.com/tv";
  contents.listeners["did-fail-load"][0]({}, -102, "REFUSED", failedUrl, true);
  contents.url = failedUrl;
  contents.listeners["did-finish-load"][0]();
  assert.deepEqual(
    diagnostics.records.map((entry) => entry.event),
    ["load-failed"],
  );
});

test("without a recorder the navigation policy adds no new listeners", () => {
  const contents = fakeContents();
  installNavigationPolicy(contents, {
    targetUrl: "https://www.youtube.com/tv",
    opener: OPENER,
    presenter: PRESENTER,
  });
  assert.ok(!contents.subscribed.includes("did-navigate"));
  assert.deepEqual(contents.subscribed, [
    "will-navigate",
    "will-redirect",
    "did-finish-load",
    "did-fail-load",
  ]);
});

test("popup policy records auth-window open/close only when wired", () => {
  const records = [];
  const childListeners = {};
  let openHandler;
  const fakeChild = {
    close: () => undefined,
    webContents: { on: () => undefined },
    on: (name, callback) => {
      childListeners[name] = callback;
    },
  };
  const host = {
    setWindowOpenHandler: (handler) => {
      openHandler = handler;
    },
    on: (event, listener) => {
      if (event === "did-create-window") {
        listener(fakeChild);
      }
      return undefined;
    },
  };
  installPopupPolicy(host, {
    opener: OPENER,
    authOrigins: ["https://accounts.google.com"],
    diagnostics: { record: (input) => records.push(input) },
  });
  const decision = openHandler({
    url: "https://accounts.google.com/o/oauth2?SAPISID=ZZSECRETZZ",
  });
  assert.equal(decision.action, "allow");
  assert.equal(typeof childListeners["closed"], "function");
  childListeners["closed"]();
  assert.deepEqual(
    records.map((entry) => entry.event),
    ["auth-window-opened", "auth-window-closed"],
  );
  assert.equal(records[0].windowKind, "auth");
});

test("without a recorder the popup policy attaches no child close hook", () => {
  let childOnCalls = 0;
  let openHandler;
  const host = {
    setWindowOpenHandler: (handler) => {
      openHandler = handler;
    },
    on: (event, listener) => {
      if (event === "did-create-window") {
        listener({
          close: () => undefined,
          webContents: { on: () => undefined },
          on: () => {
            childOnCalls += 1;
          },
        });
      }
      return undefined;
    },
  };
  installPopupPolicy(host, {
    opener: OPENER,
    authOrigins: ["https://accounts.google.com"],
  });
  const decision = openHandler({ url: "https://accounts.google.com/x" });
  assert.equal(decision.action, "allow");
  assert.equal(childOnCalls, 0);
});
