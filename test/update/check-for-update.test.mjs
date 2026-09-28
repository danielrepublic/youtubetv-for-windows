import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkForUpdate } from "../../src/main/update/check-for-update.ts";
import { createMemoryEtagCache } from "../../src/main/update/discovery.ts";
import { acquireUpdateLock } from "../../src/main/update/lock.ts";
import {
  DEFAULT_INSTALLER_BYTES as INSTALLER_BYTES,
  INSTALLER_ASSET_URL,
  INSTALLER_REDIRECT_URL,
  MANIFEST_ASSET_URL,
  RELEASES_LATEST_URL,
  SIGNATURE_ASSET_URL,
  bytesResponse,
  buildScenario,
  createAbortTransport,
  errorResponse,
  jsonResponse,
  plantLockFile,
  prettyManifestText,
  readUpdateState,
  redirectResponse,
  sha256Hex,
} from "./fixture-helpers.mjs";

const CDN_ONE = "https://objects.githubusercontent.com/asset/one";
const CDN_TWO = "https://release-assets.githubusercontent.com/asset/two";
const CDN_THREE = "https://github-releases.githubusercontent.com/asset/three";
const CDN_FOUR = "https://objects.githubusercontent.com/asset/four";
const LOOP_A = "https://objects.githubusercontent.com/loop/a";
const LOOP_B = "https://objects.githubusercontent.com/loop/b";

function runFixtureCheck(fixture) {
  return checkForUpdate({
    transport: fixture.transport,
    currentVersion: fixture.currentVersion,
    appVersion: fixture.appVersion,
    bootstrapVersion: fixture.bootstrapVersion,
    keyring: fixture.keyring,
    baseDirectory: fixture.baseDirectory,
    etagCache: fixture.etagCache,
    now: fixture.now,
    limits: fixture.limits,
  });
}

function truncatingInstallerResponse() {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(INSTALLER_BYTES.subarray(0, 512));
      } else {
        controller.error(new Error("connection reset mid-stream"));
      }
    },
  });
  return new Response(stream, {
    headers: { "content-length": String(INSTALLER_BYTES.length) },
  });
}

/**
 * The adversarial rejection corpus. Each entry mutates exactly one aspect of
 * the otherwise-valid happy-path fixture, so the resulting classified code is
 * attributable to that mutation and to nothing else.
 */
const CORPUS = [
  {
    name: "malformed manifest JSON",
    expected: { kind: "failed", code: "malformed-manifest-json" },
    scenario: { manifestText: () => "{ definitely not json" },
  },
  {
    name: "manifest with duplicate keys",
    expected: { kind: "failed", code: "duplicate-json-key" },
    scenario: {
      manifestText: (manifest) =>
        prettyManifestText(manifest).replace(
          '"channel": "stable"',
          '"channel": "stable",\n  "channel": "beta"',
        ),
    },
  },
  {
    name: "unsupported schema version",
    expected: { kind: "failed", code: "unsupported-schema-version" },
    scenario: { manifestOverrides: { schemaVersion: 2 } },
  },
  {
    name: "unknown extra manifest key",
    expected: { kind: "failed", code: "unknown-manifest-key" },
    scenario: { manifestOverrides: { notes: "unexpected" } },
  },
  {
    name: "missing keyId",
    expected: { kind: "failed", code: "missing-manifest-key" },
    scenario: { omitManifestKeys: ["keyId"] },
  },
  {
    name: "unknown keyId",
    expected: { kind: "failed", code: "unknown-key-id" },
    scenario: { manifestOverrides: { keyId: "not-in-keyring" } },
  },
  {
    name: "bit-flipped signature",
    expected: { kind: "failed", code: "invalid-signature" },
    scenario: {
      signatureBase64: ({ canonicalText, keyPair }) => {
        const raw = Buffer.from(
          keyPair.signBytes(Buffer.from(canonicalText, "utf8")),
          "base64",
        );
        raw[0] ^= 0x01;
        return raw.toString("base64");
      },
    },
  },
  {
    name: "signature over the raw file bytes instead of canonical bytes",
    expected: { kind: "failed", code: "invalid-signature" },
    scenario: {
      signatureBase64: ({ manifest, keyPair }) =>
        keyPair.signBytes(Buffer.from(prettyManifestText(manifest), "utf8")),
    },
  },
  {
    name: "wrong repository",
    expected: { kind: "skipped", code: "wrong-repository" },
    scenario: {
      releaseOverrides: {
        url: "https://api.github.com/repos/attacker/other/releases/1",
      },
    },
  },
  {
    name: "draft release",
    expected: { kind: "skipped", code: "draft-release" },
    scenario: { releaseOverrides: { draft: true } },
  },
  {
    name: "prerelease release",
    expected: { kind: "skipped", code: "prerelease" },
    scenario: { releaseOverrides: { prerelease: true } },
  },
  {
    name: "missing manifest asset",
    expected: { kind: "skipped", code: "missing-manifest-asset" },
    scenario: { releaseOptions: { includeManifestAsset: false } },
  },
  {
    name: "missing signature asset",
    expected: { kind: "skipped", code: "missing-signature-asset" },
    scenario: { releaseOptions: { includeSignatureAsset: false } },
  },
  {
    name: "release tag mismatch",
    expected: { kind: "failed", code: "release-tag-mismatch" },
    scenario: {
      manifestOverrides: { releaseTag: "v9.9.9" },
      releaseOptions: { tagName: "v2.0.0" },
    },
  },
  {
    name: "wrong installer asset name",
    expected: { kind: "failed", code: "installer-asset-mismatch" },
    scenario: {
      manifestOverrides: { installerAssetName: "other-installer.exe" },
      releaseOptions: { installerAssetName: null },
    },
  },
  {
    name: "empty installer body",
    expected: { kind: "failed", code: "installer-empty" },
    scenario: {
      responses: {
        [INSTALLER_REDIRECT_URL]: bytesResponse(Buffer.alloc(0), {
          headers: { "content-length": "0" },
        }),
      },
    },
  },
  {
    name: "wrong installer sha256",
    expected: { kind: "failed", code: "installer-hash-mismatch" },
    scenario: {
      manifestOverrides: { sha256: sha256Hex(Buffer.from("not the bytes")) },
    },
  },
  {
    name: "wrong installer size",
    expected: { kind: "failed", code: "installer-size-mismatch" },
    scenario: {
      manifestOverrides: { size: INSTALLER_BYTES.length + 1 },
    },
  },
  {
    name: "downgrade version",
    expected: { kind: "failed", code: "downgrade" },
    scenario: {
      manifestOverrides: { version: "0.9.0", releaseTag: "v0.9.0" },
    },
  },
  {
    name: "replayed older signed manifest against a newer installation",
    expected: { kind: "failed", code: "downgrade" },
    scenario: {
      manifestOverrides: { version: "0.9.0", releaseTag: "v0.9.0" },
      currentVersion: "5.0.0",
    },
  },
  {
    name: "equal version is up to date, not an install",
    expected: { kind: "up-to-date", code: undefined },
    scenario: {
      manifestOverrides: { version: "1.0.0", releaseTag: "v1.0.0" },
      currentVersion: "1.0.0",
    },
  },
  {
    name: "unsupported minimum app version",
    expected: { kind: "failed", code: "min-app-version-unsupported" },
    scenario: { manifestOverrides: { minAppVersion: "2.0.0" } },
  },
  {
    name: "unsupported minimum bootstrap version",
    expected: { kind: "failed", code: "min-bootstrap-version-unsupported" },
    scenario: { manifestOverrides: { minBootstrapVersion: "2.0.0" } },
  },
  {
    name: "non-stable channel",
    expected: { kind: "failed", code: "channel-not-allowed" },
    scenario: { manifestOverrides: { channel: "beta" } },
  },
  {
    name: "prerelease manifest version",
    expected: { kind: "failed", code: "prerelease-version-unsupported" },
    scenario: {
      manifestOverrides: { version: "2.1.0-beta.1" },
    },
  },
  {
    name: "initial request to a non-api host",
    expected: { kind: "failed", code: "unsupported-initial-host" },
    scenario: {
      releaseOptions: {
        manifestAssetUrl: "https://evil.example/update-manifest.json",
      },
    },
  },
  {
    name: "redirect to a disallowed host",
    expected: { kind: "failed", code: "disallowed-redirect-host" },
    scenario: {
      responses: {
        [MANIFEST_ASSET_URL]: redirectResponse("https://evil.example/manifest"),
      },
    },
  },
  {
    name: "redirect that downgrades to http",
    expected: { kind: "failed", code: "insecure-redirect" },
    scenario: {
      responses: {
        [MANIFEST_ASSET_URL]: redirectResponse(
          "http://objects.githubusercontent.com/manifest",
        ),
      },
    },
  },
  {
    name: "four redirects",
    expected: { kind: "failed", code: "redirect-limit-exceeded" },
    scenario: {
      responses: {
        [MANIFEST_ASSET_URL]: redirectResponse(CDN_ONE),
        [CDN_ONE]: redirectResponse(CDN_TWO),
        [CDN_TWO]: redirectResponse(CDN_THREE),
        [CDN_THREE]: redirectResponse(CDN_FOUR),
      },
    },
  },
  {
    name: "redirect loop",
    expected: { kind: "failed", code: "redirect-loop" },
    scenario: {
      responses: {
        [MANIFEST_ASSET_URL]: redirectResponse(LOOP_A),
        [LOOP_A]: redirectResponse(LOOP_B),
        [LOOP_B]: redirectResponse(LOOP_A),
      },
    },
  },
  {
    name: "rate limit",
    expected: { kind: "skipped", code: "rate-limited" },
    scenario: {
      responses: {
        [RELEASES_LATEST_URL]: errorResponse(403, {
          "x-ratelimit-remaining": "0",
        }),
      },
    },
  },
  {
    name: "HTTP 500",
    expected: { kind: "skipped", code: "http-error" },
    scenario: {
      responses: { [RELEASES_LATEST_URL]: errorResponse(500) },
    },
  },
  {
    name: "request timeout",
    expected: { kind: "skipped", code: "network-timeout" },
    scenario: {
      transport: () => createAbortTransport(),
      limits: { requestTimeoutMs: 25, retries: 0 },
    },
  },
  {
    name: "offline network",
    expected: { kind: "skipped", code: "network-offline" },
    scenario: {
      transport: () => () => {
        const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        });
        throw new TypeError("fetch failed", { cause });
      },
    },
  },
  {
    name: "lock held by another attempt",
    expected: { kind: "skipped", code: "lock-held" },
    expectedTransportCalls: 0,
    scenario: { preLock: true },
  },
  {
    name: "installer truncated mid-stream",
    expected: { kind: "failed", code: "download-truncated" },
    scenario: {
      responses: { [INSTALLER_REDIRECT_URL]: truncatingInstallerResponse() },
    },
  },
  {
    name: "installer grow past signed size",
    expected: { kind: "failed", code: "installer-size-mismatch" },
    scenario: {
      responses: {
        [INSTALLER_REDIRECT_URL]: bytesResponse(
          Buffer.concat([INSTALLER_BYTES, Buffer.from([0x2a])]),
        ),
      },
    },
  },
];

test("the corpus covers every required rejection class and is non-empty", () => {
  assert.ok(
    CORPUS.length >= 28,
    `the adversarial corpus has only ${CORPUS.length} cases`,
  );
  const codes = new Set(CORPUS.map((entry) => entry.expected.code));
  for (const required of [
    "malformed-manifest-json",
    "duplicate-json-key",
    "unsupported-schema-version",
    "unknown-manifest-key",
    "missing-manifest-key",
    "unknown-key-id",
    "invalid-signature",
    "wrong-repository",
    "draft-release",
    "prerelease",
    "missing-manifest-asset",
    "missing-signature-asset",
    "release-tag-mismatch",
    "installer-asset-mismatch",
    "installer-empty",
    "installer-hash-mismatch",
    "installer-size-mismatch",
    "downgrade",
    "min-app-version-unsupported",
    "min-bootstrap-version-unsupported",
    "channel-not-allowed",
    "unsupported-initial-host",
    "disallowed-redirect-host",
    "insecure-redirect",
    "redirect-limit-exceeded",
    "redirect-loop",
    "rate-limited",
    "network-timeout",
    "network-offline",
    "http-error",
    "lock-held",
    "download-truncated",
  ]) {
    assert.ok(codes.has(required), `the corpus is missing a ${required} case`);
  }
});

for (const corpusCase of CORPUS) {
  test(`rejects ${corpusCase.name} with ${corpusCase.expected.code ?? corpusCase.expected.kind}`, async (t) => {
    const fixture = buildScenario(corpusCase.scenario);
    t.after(fixture.cleanup);
    if (corpusCase.scenario.preLock === true) {
      plantLockFile(fixture.baseDirectory, { acquiredAt: fixture.now() });
    }
    const result = await runFixtureCheck(fixture);
    assert.equal(
      result.kind,
      corpusCase.expected.kind,
      `unexpected kind: ${JSON.stringify(result)}`,
    );
    if (corpusCase.expected.code !== undefined) {
      assert.equal(
        result.code,
        corpusCase.expected.code,
        `unexpected code: ${JSON.stringify(result)}`,
      );
      assert.equal(typeof result.message, "string");
      assert.ok(result.message.length > 0, "every rejection carries a message");
    }
    const state = readUpdateState(fixture.baseDirectory);
    if (corpusCase.scenario.preLock === true) {
      assert.equal(
        state.lockExists,
        true,
        "a foreign lock must be left exactly where it was",
      );
    } else {
      assert.equal(
        state.lockExists,
        false,
        "the lock must be released on every terminal path",
      );
    }
    assert.deepEqual(
      state.pendingDirectories,
      [],
      "no pending directory may survive a rejection",
    );
    if (corpusCase.expectedTransportCalls !== undefined) {
      assert.equal(
        fixture.calls.length,
        corpusCase.expectedTransportCalls,
        "a lock-held attempt must not touch the network",
      );
    }
  });
}

test("happy path: verified newer release yields update-ready with exact installer bytes", async (t) => {
  const fixture = buildScenario({
    limits: { retries: 2, retryDelayMs: 0 },
  });
  t.after(fixture.cleanup);

  const result = await runFixtureCheck(fixture);
  assert.equal(result.kind, "update-ready");
  assert.equal(result.manifest.version, "2.0.0");
  assert.equal(result.manifest.releaseTag, fixture.release.tag_name);
  assert.match(result.nonce, /^[0-9a-f]{32}$/);

  const expectedPath = path.join(
    fixture.baseDirectory,
    "pending",
    result.nonce,
    fixture.manifest.installerAssetName,
  );
  assert.equal(result.installerPath, expectedPath);
  assert.deepEqual(fs.readFileSync(result.installerPath), INSTALLER_BYTES);
  assert.deepEqual(fs.readdirSync(path.dirname(result.installerPath)), [
    fixture.manifest.installerAssetName,
  ]);

  const state = readUpdateState(fixture.baseDirectory);
  assert.equal(state.lockExists, false);
  assert.deepEqual(state.pendingDirectories, [result.nonce]);

  // The served manifest was pretty-printed with reversed keys, so success
  // proves the signature was verified over canonical bytes.
  assert.notEqual(fixture.manifestText, fixture.canonicalText);

  assert.ok(fixture.calls.length >= 5, "discovery plus three assets");
  for (const call of fixture.calls) {
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.redirect, "manual");
    assert.ok(!("authorization" in call.headers));
    assert.ok(!("cookie" in call.headers));
  }
  assert.equal(
    fixture.calls[0].headers["user-agent"]?.includes("youtubetv-for-windows"),
    true,
  );
});

test("a second attempt while the lock is held is skipped, then succeeds after release", async (t) => {
  const fixture = buildScenario();
  t.after(fixture.cleanup);
  const held = acquireUpdateLock({
    baseDirectory: fixture.baseDirectory,
    now: fixture.now,
    staleMs: 60_000,
  });
  assert.equal(held.ok, true);

  const blocked = await runFixtureCheck(fixture);
  assert.equal(blocked.kind, "skipped");
  assert.equal(blocked.code, "lock-held");
  assert.equal(fixture.calls.length, 0);

  held.release();
  const afterRelease = await runFixtureCheck(fixture);
  assert.equal(afterRelease.kind, "update-ready");
  assert.equal(readUpdateState(fixture.baseDirectory).lockExists, false);
});

test("a stale lock is reclaimed and the update completes", async (t) => {
  const fixture = buildScenario({
    limits: { lockStaleMs: 60_000, retries: 0 },
  });
  t.after(fixture.cleanup);
  plantLockFile(fixture.baseDirectory, {
    acquiredAt: fixture.now() - 120_000,
    pid: 999_999,
  });
  const result = await runFixtureCheck(fixture);
  assert.equal(result.kind, "update-ready");
  assert.equal(readUpdateState(fixture.baseDirectory).lockExists, false);
});

test("ETag 304 reuses the cached release instead of a fresh 200 body", async (t) => {
  const cache = createMemoryEtagCache();
  const first = buildScenario({
    etagCache: cache,
    manifestOverrides: { version: "1.0.0", releaseTag: "v1.0.0" },
    currentVersion: "1.0.0",
  });
  t.after(first.cleanup);
  const firstResult = await runFixtureCheck(first);
  assert.equal(firstResult.kind, "up-to-date");

  const second = buildScenario({
    etagCache: cache,
    manifestOverrides: { version: "1.0.0", releaseTag: "v1.0.0" },
    currentVersion: "1.0.0",
    responses: {
      [RELEASES_LATEST_URL]: new Response(null, { status: 304 }),
    },
  });
  t.after(second.cleanup);
  const secondResult = await runFixtureCheck(second);
  assert.equal(secondResult.kind, "up-to-date");
  assert.equal(second.calls[0].url, RELEASES_LATEST_URL);
  assert.equal(second.calls[0].headers["if-none-match"], '"release-etag-1"');
  assert.equal(
    second.calls.filter((call) => call.url === RELEASES_LATEST_URL).length,
    1,
    "the 304 must not be retried as a fresh release fetch",
  );
  assert.ok(
    second.calls.length >= 3,
    "the cached release still drives manifest and signature verification",
  );
});

test("retries a transient discovery failure and still reports update-ready", async (t) => {
  const fixture = buildScenario({
    limits: { retries: 2, retryDelayMs: 0, requestTimeoutMs: 500 },
    respond: (url, _call, index, current) => {
      if (url === RELEASES_LATEST_URL) {
        if (index < 2) {
          return errorResponse(500);
        }
        return jsonResponse(current.release, {
          headers: { etag: '"release-etag-1"' },
        });
      }
      if (url === MANIFEST_ASSET_URL) {
        return bytesResponse(Buffer.from(current.manifestText, "utf8"));
      }
      if (url === SIGNATURE_ASSET_URL) {
        return bytesResponse(
          Buffer.from(`${current.signatureBase64}\n`, "utf8"),
        );
      }
      if (url === INSTALLER_ASSET_URL) {
        return redirectResponse(INSTALLER_REDIRECT_URL);
      }
      if (url === INSTALLER_REDIRECT_URL) {
        return bytesResponse(current.installerBytes);
      }
      throw new Error(`unexpected request URL: ${url}`);
    },
  });
  t.after(fixture.cleanup);
  const result = await runFixtureCheck(fixture);
  assert.equal(result.kind, "update-ready");
  assert.ok(fixture.calls.length >= 4);
});
