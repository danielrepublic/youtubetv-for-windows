// Pure-logic unit suite for the child-popup policy: destination decisions,
// child lifecycle decisions, override-option inheritance, and wiring against
// fake hosts. No Electron here.

import assert from "node:assert/strict";
import test from "node:test";

const {
  DEFAULT_AUTH_ORIGINS,
  childWindowOverrides,
  decideChildNavigation,
  decidePopupDestination,
  handleChildNavigation,
  handleWindowOpen,
  installPopupPolicy,
} = await import("../../src/main/popup-policy.ts");

test("the default allowlist is exactly the two Google auth origins", () => {
  assert.deepEqual(
    [...DEFAULT_AUTH_ORIGINS],
    ["https://accounts.google.com", "https://accounts.youtube.com"],
  );
});

test("decidePopupDestination allows only exact allowlist origins", () => {
  assert.equal(
    decidePopupDestination("https://accounts.google.com/signin"),
    "allow-child",
  );
  assert.equal(
    decidePopupDestination("https://accounts.youtube.com/x?y=1#z"),
    "allow-child",
  );
  assert.equal(
    decidePopupDestination("https://evil.accounts.google.com/"),
    "open-external",
  );
  assert.equal(
    decidePopupDestination("https://accounts.google.com.evil.example/"),
    "open-external",
  );
  assert.equal(decidePopupDestination("http://accounts.google.com/"), "deny");
  assert.equal(decidePopupDestination("https://example.com/"), "open-external");
  assert.equal(
    decidePopupDestination("https://www.youtube.com/"),
    "open-external",
  );
});

test("decidePopupDestination denies every dangerous scheme with no external call", () => {
  const corpus = [
    "javascript:alert(document.domain)",
    "JaVaScRiPt:alert(1)",
    "file:///C:/Windows/win.ini",
    "FILE:///etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "DATA:text/html,hi",
    "ytvwrapper://launch?target=evil",
    "custom-scheme:anything",
    "",
    "not a url at all",
    "https://",
    "http://example.com/",
  ];
  for (const candidate of corpus) {
    assert.equal(
      decidePopupDestination(candidate),
      "deny",
      `expected deny for ${JSON.stringify(candidate)}`,
    );
  }
});

test("the auth allowlist is injectable for local fixture origins", () => {
  const origins = ["http://127.0.0.1:9001", "http://127.0.0.1:9002"];
  assert.equal(
    decidePopupDestination("http://127.0.0.1:9001/auth", origins),
    "allow-child",
  );
  assert.equal(
    decidePopupDestination("http://127.0.0.1:9003/", origins),
    "deny",
  );
  assert.equal(
    decidePopupDestination("https://example.com/", origins),
    "open-external",
  );
});

test("allowed children inherit the session: overrides carry no partition", () => {
  const overrides = childWindowOverrides();
  assert.deepEqual(overrides, {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  assert.ok(!("partition" in overrides), "a partition key would resession");
  assert.ok(!("session" in overrides), "a session key would resession");
});

test("handleWindowOpen allows auth, delegates https, denies silently", () => {
  const external = [];
  const wiring = {
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
  };
  const allowed = handleWindowOpen(wiring, {
    url: "https://accounts.google.com/signin",
  });
  assert.equal(allowed.action, "allow");
  assert.ok(allowed.overrideBrowserWindowOptions !== undefined);
  assert.ok(
    !("partition" in allowed.overrideBrowserWindowOptions),
    "allowed children must inherit the opener session",
  );
  assert.equal(allowed.overrideBrowserWindowOptions.contextIsolation, true);
  assert.equal(allowed.overrideBrowserWindowOptions.sandbox, true);
  assert.equal(allowed.overrideBrowserWindowOptions.nodeIntegration, false);
  const delegated = handleWindowOpen(wiring, { url: "https://example.com/x" });
  assert.deepEqual(delegated, { action: "deny" });
  const silenced = handleWindowOpen(wiring, { url: "javascript:alert(1)" });
  assert.deepEqual(silenced, { action: "deny" });
  assert.deepEqual(external, ["https://example.com/x"]);
});

test("decideChildNavigation keeps auth + youtube, closes the rest", () => {
  assert.equal(decideChildNavigation("https://accounts.google.com/a"), "stay");
  assert.equal(decideChildNavigation("https://accounts.youtube.com/b"), "stay");
  assert.equal(decideChildNavigation("https://www.youtube.com/tv"), "stay");
  assert.equal(
    decideChildNavigation("https://example.com/"),
    "close-and-external",
  );
  assert.equal(decideChildNavigation("javascript:alert(1)"), "close-silently");
  assert.equal(decideChildNavigation("file:///x"), "close-silently");
  assert.equal(decideChildNavigation("data:text/html,x"), "close-silently");
  assert.equal(decideChildNavigation("custom://x"), "close-silently");
  assert.equal(decideChildNavigation("http://example.com/"), "close-silently");
  assert.equal(decideChildNavigation("garbage"), "close-silently");
});

test("handleChildNavigation closes violators and delegates only valid https", () => {
  const external = [];
  const wiring = {
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
  };
  const cancellable = () => {
    let cancelled = false;
    let closed = false;
    return {
      event: {
        preventDefault: () => {
          cancelled = true;
        },
      },
      child: {
        close: () => {
          closed = true;
        },
      },
      get cancelled() {
        return cancelled;
      },
      get closed() {
        return closed;
      },
    };
  };
  const staying = cancellable();
  assert.equal(
    handleChildNavigation(
      wiring,
      staying.child,
      staying.event,
      "https://accounts.google.com/a",
    ),
    "stay",
  );
  assert.equal(staying.cancelled, false);
  assert.equal(staying.closed, false);
  const expelled = cancellable();
  assert.equal(
    handleChildNavigation(
      wiring,
      expelled.child,
      expelled.event,
      "https://example.com/evil",
    ),
    "close-and-external",
  );
  assert.equal(expelled.cancelled, true);
  assert.equal(expelled.closed, true);
  const silent = cancellable();
  assert.equal(
    handleChildNavigation(
      wiring,
      silent.child,
      silent.event,
      "javascript:alert(1)",
    ),
    "close-silently",
  );
  assert.equal(silent.cancelled, true);
  assert.equal(silent.closed, true);
  assert.deepEqual(external, ["https://example.com/evil"]);
});

test("installPopupPolicy wires the handler and guards created children", () => {
  const external = [];
  let openHandler = null;
  let createdListener = null;
  const childGuards = [];
  const host = {
    setWindowOpenHandler: (handler) => {
      openHandler = handler;
    },
    on: (event, listener) => {
      assert.equal(event, "did-create-window");
      createdListener = listener;
      return undefined;
    },
  };
  installPopupPolicy(host, {
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
  });
  assert.ok(openHandler !== null, "a window-open handler must be installed");
  assert.ok(
    createdListener !== null,
    "a did-create-window listener must be installed",
  );
  const allowed = openHandler({ url: "https://accounts.google.com/" });
  assert.equal(allowed.action, "allow");
  const denied = openHandler({ url: "https://example.com/" });
  assert.equal(denied.action, "deny");
  // Simulate a created child, then drive its guard both ways.
  let childClosed = false;
  const child = {
    close: () => {
      childClosed = true;
    },
    webContents: {
      on: (event, listener) => {
        childGuards.push({ event, listener });
        return undefined;
      },
    },
  };
  createdListener(child);
  assert.deepEqual(childGuards.map((entry) => entry.event).sort(), [
    "will-navigate",
    "will-redirect",
  ]);
  for (const entry of childGuards) {
    let cancelled = false;
    entry.listener(
      {
        preventDefault: () => {
          cancelled = true;
        },
      },
      "https://example.com/x",
    );
    assert.equal(cancelled, true);
  }
  assert.equal(childClosed, true);
  assert.deepEqual(external, [
    "https://example.com/",
    "https://example.com/x",
    "https://example.com/x",
  ]);
});
