import assert from "node:assert/strict";
import test from "node:test";
import {
  openDownloadStream,
  readBodyBytes,
} from "../../src/main/update/http-download.ts";
import {
  bytesResponse,
  createTransport,
  errorResponse,
  redirectResponse,
  TEST_LIMITS,
} from "./fixture-helpers.mjs";

const API_URL = "https://api.github.com/repos/x/y/releases/assets/1";
const CDN_URL = "https://objects.githubusercontent.com/asset/1";

function download(transport, url = API_URL, options = {}) {
  return openDownloadStream(transport, url, {
    headers: { accept: "application/octet-stream" },
    maxBytes: 1024,
    limits: TEST_LIMITS,
    ...options,
  });
}

test("sends only the declared headers with credentials omitted", async () => {
  const recording = createTransport(() => bytesResponse("ok"));
  const outcome = await download(recording.transport);
  assert.equal(outcome.ok, true);
  assert.equal(recording.calls.length, 1);
  const [call] = recording.calls;
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "manual");
  assert.deepEqual(call.headers, { accept: "application/octet-stream" });
  assert.ok(!("authorization" in call.headers));
  assert.ok(!("cookie" in call.headers));
});

test("follows a 302 to a documented asset host", async () => {
  const recording = createTransport((url) =>
    url === API_URL ? redirectResponse(CDN_URL) : bytesResponse("payload"),
  );
  const outcome = await download(recording.transport);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.finalUrl, CDN_URL);
  assert.equal(recording.calls.length, 2);
  assert.deepEqual(recording.calls[1].headers, {
    accept: "application/octet-stream",
  });
  const body = await readBodyBytes(outcome.response, 1024);
  assert.equal(body.ok, true);
  assert.equal(body.text, "payload");
});

test("rejects a 302 without a Location header", async () => {
  const recording = createTransport(() => new Response(null, { status: 302 }));
  const outcome = await download(recording.transport);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "malformed-redirect");
});

test("retries a transient 500 and succeeds", async () => {
  let attempt = 0;
  const recording = createTransport(() => {
    attempt += 1;
    return attempt < 3 ? errorResponse(500) : bytesResponse("ok");
  });
  const outcome = await download(recording.transport, API_URL, {
    limits: { ...TEST_LIMITS, retries: 2, retryDelayMs: 0 },
  });
  assert.equal(outcome.ok, true);
  assert.equal(recording.calls.length, 3);
});

test("classifies a persistent 500 as an HTTP error", async () => {
  const recording = createTransport(() => errorResponse(500));
  const outcome = await download(recording.transport, API_URL, {
    limits: { ...TEST_LIMITS, retries: 1, retryDelayMs: 0 },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "http-error");
  assert.equal(recording.calls.length, 2);
});

test("does not retry a definite 4xx", async () => {
  const recording = createTransport(() => errorResponse(404));
  const outcome = await download(recording.transport, API_URL, {
    limits: { ...TEST_LIMITS, retries: 2, retryDelayMs: 0 },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "http-error");
  assert.equal(recording.calls.length, 1);
});

test("classifies rate limiting on 403 with headers and on any 429", async () => {
  const forbiddenWithHeaders = await download(
    createTransport(() => errorResponse(403, { "x-ratelimit-remaining": "0" }))
      .transport,
  );
  assert.equal(forbiddenWithHeaders.code, "rate-limited");

  const plainForbidden = await download(
    createTransport(() => errorResponse(403)).transport,
  );
  assert.equal(plainForbidden.code, "http-error");

  const tooMany = await download(
    createTransport(() => errorResponse(429)).transport,
  );
  assert.equal(tooMany.code, "rate-limited");
});

test("classifies a request timeout", async () => {
  const transport = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  const outcome = await download(transport, API_URL, {
    limits: { ...TEST_LIMITS, requestTimeoutMs: 25, retries: 0 },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "network-timeout");
});

test("classifies an offline DNS failure from the cause chain", async () => {
  const cause = Object.assign(
    new Error("getaddrinfo ENOTFOUND api.github.com"),
    { code: "ENOTFOUND" },
  );
  const transport = () => {
    throw new TypeError("fetch failed", { cause });
  };
  const outcome = await download(transport);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "network-offline");
});

test("classifies an unclassified transport failure as a network error", async () => {
  const transport = () => {
    throw new Error("boom");
  };
  const outcome = await download(transport);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "network-error");
});

test("rejects an initial request to a non-api host without any call", async () => {
  const recording = createTransport(() => bytesResponse("ok"));
  const outcome = await download(
    recording.transport,
    "https://evil.example/manifest.json",
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unsupported-initial-host");
  assert.equal(recording.calls.length, 0);
});

test("rejects a declared content length over the byte budget", async () => {
  const recording = createTransport(() =>
    bytesResponse("x", { headers: { "content-length": "999999" } }),
  );
  const outcome = await download(recording.transport);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "download-too-large");
});

test("readBodyBytes enforces the byte budget while streaming", async () => {
  const response = bytesResponse(Buffer.alloc(200));
  const body = await readBodyBytes(response, 10);
  assert.equal(body.ok, false);
  assert.equal(body.code, "download-too-large");
});

test("readBodyBytes classifies a short body against content-length", async () => {
  const response = bytesResponse(Buffer.from("abc"), {
    headers: { "content-length": "10" },
  });
  const body = await readBodyBytes(response, 1024);
  assert.equal(body.ok, false);
  assert.equal(body.code, "download-truncated");
});

test("readBodyBytes classifies a mid-stream failure", async () => {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
  const response = new Response(stream, {
    headers: { "content-length": "20" },
  });
  const body = await readBodyBytes(response, 1024);
  assert.equal(body.ok, false);
  assert.equal(body.code, "download-truncated");
});

test("readBodyBytes returns the exact bytes and UTF-8 text", async () => {
  const response = bytesResponse(Buffer.from("héllo", "utf8"));
  const body = await readBodyBytes(response, 1024);
  assert.equal(body.ok, true);
  assert.equal(body.text, "héllo");
  assert.deepEqual(body.bytes, Buffer.from("héllo", "utf8"));
});
