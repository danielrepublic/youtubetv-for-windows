// Pure-logic unit suite for the main-window navigation policy and the TV
// route recovery loop. No Electron here: every decision function is pure and
// the recovery loop runs against injected fakes.

import assert from "node:assert/strict";
import test from "node:test";

const {
  classifyTvRouteUrl,
  decideMainNavigation,
  handleMainNavigation,
  installNavigationPolicy,
  recoverTvRoute,
  isYoutubeHost,
  MAX_ROUTE_RETRIES,
} = await import("../../src/main/navigation-policy.ts");

test("isYoutubeHost matches youtube.com and subdomains only", () => {
  assert.equal(isYoutubeHost("youtube.com"), true);
  assert.equal(isYoutubeHost("www.youtube.com"), true);
  assert.equal(isYoutubeHost("m.youtube.com"), true);
  assert.equal(isYoutubeHost("YOUTUBE.COM"), true);
  assert.equal(isYoutubeHost("youtube.com.evil.example"), false);
  assert.equal(isYoutubeHost("notyoutube.com"), false);
  assert.equal(isYoutubeHost("example.com"), false);
  assert.equal(isYoutubeHost(""), false);
});

test("classifyTvRouteUrl accepts the TV route with hash/query variants", () => {
  assert.equal(classifyTvRouteUrl("https://www.youtube.com/tv"), "ok");
  assert.equal(classifyTvRouteUrl("https://www.youtube.com/tv/"), "ok");
  assert.equal(classifyTvRouteUrl("https://www.youtube.com/tv/watch#x"), "ok");
  assert.equal(
    classifyTvRouteUrl("https://www.youtube.com/tv?app=desktop"),
    "ok",
  );
  assert.equal(classifyTvRouteUrl("https://m.youtube.com/tv/browse"), "ok");
});

test("classifyTvRouteUrl flags the known bounce off the TV route", () => {
  assert.equal(
    classifyTvRouteUrl("https://www.youtube.com/"),
    "redirected-away",
  );
  assert.equal(
    classifyTvRouteUrl("https://www.youtube.com/results?search_query=x"),
    "redirected-away",
  );
  assert.equal(
    classifyTvRouteUrl("https://www.youtube.com/tvx"),
    "redirected-away",
  );
  assert.equal(
    classifyTvRouteUrl("https://www.youtube.com/t"),
    "redirected-away",
  );
  assert.equal(classifyTvRouteUrl("https://example.com/"), "redirected-away");
  assert.equal(classifyTvRouteUrl("not a url"), "load-failed");
  assert.equal(classifyTvRouteUrl(""), "load-failed");
});

test("decideMainNavigation allows only https youtube.com navigation", () => {
  assert.equal(decideMainNavigation("https://www.youtube.com/tv"), "allow");
  assert.equal(decideMainNavigation("https://accounts.youtube.com/x"), "allow");
  assert.equal(decideMainNavigation("https://example.com/"), "open-external");
  assert.equal(
    decideMainNavigation("https://accounts.google.com/"),
    "open-external",
  );
  assert.equal(decideMainNavigation("http://www.youtube.com/tv"), "deny");
  assert.equal(decideMainNavigation("http://example.com/"), "deny");
  assert.equal(decideMainNavigation("javascript:alert(1)"), "deny");
  assert.equal(decideMainNavigation("file:///C:/evil.html"), "deny");
  assert.equal(decideMainNavigation("data:text/html,<h1>x</h1>"), "deny");
  assert.equal(decideMainNavigation("ytvwrapper://launch"), "deny");
  assert.equal(decideMainNavigation(""), "deny");
  assert.equal(decideMainNavigation("https://"), "deny");
});

test("handleMainNavigation cancels and delegates exactly per decision", () => {
  const external = [];
  const opener = {
    openExternal: (url) => {
      external.push(url);
    },
  };
  const cancellable = () => {
    let cancelled = false;
    return {
      event: {
        preventDefault: () => {
          cancelled = true;
        },
      },
      get cancelled() {
        return cancelled;
      },
    };
  };
  const allowed = cancellable();
  assert.equal(
    handleMainNavigation(opener, allowed.event, "https://www.youtube.com/tv"),
    "allow",
  );
  assert.equal(allowed.cancelled, false);
  const externalTarget = cancellable();
  assert.equal(
    handleMainNavigation(opener, externalTarget.event, "https://example.com/a"),
    "open-external",
  );
  assert.equal(externalTarget.cancelled, true);
  const silent = cancellable();
  assert.equal(
    handleMainNavigation(opener, silent.event, "javascript:alert(1)"),
    "deny",
  );
  assert.equal(silent.cancelled, true);
  assert.deepEqual(external, ["https://example.com/a"]);
});

function stubPresenter(responses) {
  const seen = [];
  return {
    seen,
    presenter: {
      showMessageBox: async (options) => {
        seen.push(options);
        const next = responses.shift();
        return { response: next ?? 2 };
      },
    },
  };
}

test("the failure dialog carries exactly three bilingual actions", async () => {
  const stub = stubPresenter([0]);
  const { showRouteFailureDialog } = await import("../../src/main/dialogs.ts");
  const action = await showRouteFailureDialog(stub.presenter, {
    kind: "redirected-away",
    failedUrl: "https://www.youtube.com/",
    attempt: 0,
  });
  assert.equal(action, "retry");
  assert.equal(stub.seen.length, 1);
  const options = stub.seen[0];
  assert.deepEqual(options.buttons, [
    "重試 (Retry)",
    "在瀏覽器中開啟 (Open in browser)",
    "支援 (Support)",
  ]);
  assert.match(options.message, /YouTube TV/);
  assert.match(options.message, /重試|重新導向|載入失敗/);
  assert.match(options.message, /redirected|failed to load/);
  assert.match(options.message, /https:\/\/www\.youtube\.com\//);
});

test("out-of-range dialog responses land on support", async () => {
  const { showRouteFailureDialog } = await import("../../src/main/dialogs.ts");
  for (const response of [2, 5, -1]) {
    const stub = stubPresenter([response]);
    const action = await showRouteFailureDialog(stub.presenter, {
      kind: "load-failed",
      failedUrl: "https://www.youtube.com/tv",
      attempt: 0,
    });
    assert.equal(action, "support");
  }
});

test("recoverTvRoute recovers when a retry lands back on /tv", async () => {
  const external = [];
  const stub = stubPresenter([0]);
  let reloads = 0;
  const outcome = await recoverTvRoute({
    kind: "redirected-away",
    failedUrl: "https://www.youtube.com/",
    targetUrl: "https://www.youtube.com/tv",
    presenter: stub.presenter,
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    reload: async () => {
      reloads += 1;
      return "https://www.youtube.com/tv";
    },
  });
  assert.equal(outcome, "recovered");
  assert.equal(reloads, 1);
  assert.deepEqual(external, []);
});

test("recoverTvRoute opens the validated failed URL in the browser", async () => {
  const external = [];
  const stub = stubPresenter([1]);
  const outcome = await recoverTvRoute({
    kind: "redirected-away",
    failedUrl: "https://www.youtube.com/",
    targetUrl: "https://www.youtube.com/tv",
    presenter: stub.presenter,
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    reload: async () => {
      throw new Error("reload must not run after open-browser");
    },
  });
  assert.equal(outcome, "dismissed-external");
  assert.deepEqual(external, ["https://www.youtube.com/"]);
});

test("recoverTvRoute opens the support release page", async () => {
  const external = [];
  const stub = stubPresenter([2]);
  const outcome = await recoverTvRoute({
    kind: "load-failed",
    failedUrl: "https://www.youtube.com/tv",
    targetUrl: "https://www.youtube.com/tv",
    presenter: stub.presenter,
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    reload: async () => {
      throw new Error("reload must not run after support");
    },
  });
  assert.equal(outcome, "dismissed-external");
  assert.deepEqual(external, [
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  ]);
});

test("recoverTvRoute never loops: bounded retries then exhaustion", async () => {
  assert.ok(MAX_ROUTE_RETRIES >= 1, "the retry budget must allow a retry");
  const external = [];
  // Always retry: one initial attempt plus exactly MAX_ROUTE_RETRIES reloads.
  const stub = stubPresenter([0, 0, 0, 0, 0, 0]);
  let reloads = 0;
  const outcome = await recoverTvRoute({
    kind: "redirected-away",
    failedUrl: "https://www.youtube.com/",
    targetUrl: "https://www.youtube.com/tv",
    presenter: stub.presenter,
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    reload: async () => {
      reloads += 1;
      return "https://www.youtube.com/";
    },
  });
  assert.equal(outcome, "retries-exhausted");
  assert.equal(reloads, MAX_ROUTE_RETRIES);
  assert.equal(stub.seen.length, MAX_ROUTE_RETRIES + 1);
  assert.deepEqual(external, []);
});

test("recoverTvRoute treats a throwing reload as load-failed and continues", async () => {
  const external = [];
  const stub = stubPresenter([0, 2]);
  let reloads = 0;
  const outcome = await recoverTvRoute({
    kind: "redirected-away",
    failedUrl: "https://www.youtube.com/",
    targetUrl: "https://www.youtube.com/tv",
    presenter: stub.presenter,
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    reload: async () => {
      reloads += 1;
      throw new Error("network down");
    },
  });
  assert.equal(outcome, "dismissed-external");
  assert.equal(reloads, 1);
  assert.deepEqual(external, [
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  ]);
});

test("the error-page finish after a failure does not recover twice", async () => {
  // Chromium commits an error page after a failed load, which fires
  // did-finish-load for the SAME URL. The wiring must consume that single
  // commit (the failure recovery already covers it) yet still classify a
  // later genuine load of the same URL.
  const listeners = {};
  let currentUrl = "about:blank";
  const contents = {
    on: (event, listener) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(listener);
      return undefined;
    },
    getURL: () => currentUrl,
    loadURL: async (url) => {
      currentUrl = url;
    },
  };
  const external = [];
  const stub = stubPresenter([2, 2, 2]);
  installNavigationPolicy(contents, {
    targetUrl: "https://www.youtube.com/tv",
    opener: {
      openExternal: (url) => {
        external.push(url);
      },
    },
    presenter: stub.presenter,
  });
  const fail = listeners["did-fail-load"][0];
  const finish = listeners["did-finish-load"][0];
  const noop = { preventDefault: () => {} };
  fail(noop, -102, "refused", "https://www.youtube.com/tv", true);
  // Chromium keeps the failed URL pending and commits its error page under
  // the same URL (proven by the Electron fixture trace: the error-page
  // finish reports the failed URL, not about:blank).
  currentUrl = "https://www.youtube.com/tv";
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stub.seen.length, 1);
  // The error-page commit for the same URL: consumed, no second dialog.
  finish();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stub.seen.length, 1);
  // A later genuine load of the same off-route URL still classifies.
  currentUrl = "https://www.youtube.com/";
  finish();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stub.seen.length, 2);
  assert.deepEqual(external, [
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
    "https://github.com/danielrepublic/youtubetv-for-windows/releases/latest",
  ]);
});
