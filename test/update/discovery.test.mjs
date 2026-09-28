import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryEtagCache,
  discoverLatestRelease,
  findManifestAsset,
  findSignatureAsset,
} from "../../src/main/update/discovery.ts";
import { UPDATE_USER_AGENT } from "../../src/main/update/redirect-policy.ts";
import {
  RELEASES_LATEST_URL,
  TEST_LIMITS,
  createRelease,
  createTransport,
  errorResponse,
  jsonResponse,
} from "./fixture-helpers.mjs";

function discover(responder, { limits = TEST_LIMITS, etagCache } = {}) {
  const recording = createTransport(responder);
  return {
    recording,
    cache: etagCache ?? createMemoryEtagCache(),
    run() {
      const cache = this.cache;
      return discoverLatestRelease({
        transport: recording.transport,
        etagCache: cache,
        limits,
      });
    },
  };
}

test("returns the release, sends the fixed user agent, and caches the ETag", async () => {
  const release = createRelease();
  const harness = discover(() =>
    jsonResponse(release, { headers: { etag: '"etag-1"' } }),
  );
  const result = await harness.run();
  assert.equal(result.ok, true);
  assert.equal(result.fromCache, false);
  assert.equal(result.release.tagName, "v2.0.0");
  const [call] = harness.recording.calls;
  assert.equal(call.headers["user-agent"], UPDATE_USER_AGENT);
  assert.equal(call.headers.accept, "application/vnd.github+json");
  assert.ok(!("if-none-match" in call.headers));
  const cached = harness.cache.get(RELEASES_LATEST_URL);
  assert.equal(cached.etag, '"etag-1"');

  const second = createTransport(() => new Response(null, { status: 304 }));
  const replay = await discoverLatestRelease({
    transport: second.transport,
    etagCache: harness.cache,
    limits: TEST_LIMITS,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.fromCache, true);
  assert.equal(second.calls[0].headers["if-none-match"], '"etag-1"');
});

test("classifies a 304 without a cached release as an HTTP error", async () => {
  const harness = discover(() => new Response(null, { status: 304 }));
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "http-error");
});

test("classifies rate limiting", async () => {
  const harness = discover(() =>
    errorResponse(403, { "x-ratelimit-remaining": "0" }),
  );
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "rate-limited");
});

test("rejects malformed JSON release bodies", async () => {
  const harness = discover(() => new Response("{not json", { status: 200 }));
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-release");
});

test("rejects a release body with duplicate keys", async () => {
  const harness = discover(
    () =>
      new Response('{"tag_name":"v2.0.0","tag_name":"v2.0.0"}', {
        status: 200,
      }),
  );
  const result = await harness.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-release");
});

test("rejects draft and prerelease flags", async () => {
  const draft = await discover(() =>
    jsonResponse(createRelease({ draft: true })),
  ).run();
  assert.equal(draft.ok, false);
  assert.equal(draft.code, "draft-release");

  const prerelease = await discover(() =>
    jsonResponse(createRelease({ prerelease: true })),
  ).run();
  assert.equal(prerelease.ok, false);
  assert.equal(prerelease.code, "prerelease");
});

test("rejects a release from another repository", async () => {
  const otherUrl = await discover(() =>
    jsonResponse(
      createRelease({
        url: "https://api.github.com/repos/attacker/other/releases/1",
      }),
    ),
  ).run();
  assert.equal(otherUrl.ok, false);
  assert.equal(otherUrl.code, "wrong-repository");

  const otherHtml = await discover(() =>
    jsonResponse(
      createRelease({
        html_url: "https://github.com/attacker/other/releases/tag/v2.0.0",
      }),
    ),
  ).run();
  assert.equal(otherHtml.ok, false);
  assert.equal(otherHtml.code, "wrong-repository");
});

test("rejects a release without a usable tag", async () => {
  const release = createRelease();
  delete release.tag_name;
  const result = await discover(() => jsonResponse(release)).run();
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-release");
});

test("rejects malformed asset entries", async () => {
  const notAnArray = createRelease();
  notAnArray.assets = "nope";
  const malformed = await discover(() => jsonResponse(notAnArray)).run();
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, "malformed-release");

  const insecureAsset = createRelease({
    manifestAssetUrl: "http://api.github.com/manifest.json",
  });
  const insecure = await discover(() => jsonResponse(insecureAsset)).run();
  assert.equal(insecure.ok, false);
  assert.equal(insecure.code, "malformed-release");
});

test("classifies missing manifest and signature assets", async () => {
  const noManifest = createRelease({ includeManifestAsset: false });
  const manifestLookup = findManifestAsset(noManifest);
  assert.equal(manifestLookup.ok, false);
  assert.equal(manifestLookup.code, "missing-manifest-asset");

  const noSignature = createRelease({ includeSignatureAsset: false });
  const signatureLookup = findSignatureAsset(noSignature);
  assert.equal(signatureLookup.ok, false);
  assert.equal(signatureLookup.code, "missing-signature-asset");
});

test("finds the exact manifest and signature assets when present", () => {
  const release = createRelease();
  const manifestLookup = findManifestAsset(release);
  assert.equal(manifestLookup.ok, true);
  assert.equal(manifestLookup.asset.name, "update-manifest.json");
  const signatureLookup = findSignatureAsset(release);
  assert.equal(signatureLookup.ok, true);
  assert.equal(signatureLookup.asset.name, "update-manifest.sig");
});

test("classifies a discovery timeout", async () => {
  const transport = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
  const result = await discoverLatestRelease({
    transport,
    etagCache: createMemoryEtagCache(),
    limits: { ...TEST_LIMITS, requestTimeoutMs: 25 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "network-timeout");
});
