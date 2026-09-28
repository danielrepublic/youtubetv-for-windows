// Deterministic fixture helpers for the update-domain test corpus.
//
// No network, no committed key material: every scenario generates an
// ephemeral Ed25519 keypair in-process and drives the domain through an
// injected fake transport. This file is intentionally NOT named
// `*.test.mjs`, so the chain runner does not execute it as a suite.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonText } from "../../src/main/update/canonical.ts";
import { createMemoryEtagCache } from "../../src/main/update/discovery.ts";
import {
  UPDATE_MANIFEST_ASSET_NAME,
  UPDATE_SIGNATURE_ASSET_NAME,
} from "../../src/main/update/manifest-schema.ts";
import { updateHomePaths } from "../../src/main/update/pending.ts";

export const REPOSITORY = "danielrepublic/youtubetv-for-windows";
export const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
export const MANIFEST_ASSET_URL = `https://api.github.com/repos/${REPOSITORY}/releases/assets/1001`;
export const SIGNATURE_ASSET_URL = `https://api.github.com/repos/${REPOSITORY}/releases/assets/1002`;
export const INSTALLER_ASSET_URL = `https://api.github.com/repos/${REPOSITORY}/releases/assets/1003`;
export const INSTALLER_ASSET_NAME = "youtubetv-for-windows-2.0.0-x64.exe";
export const INSTALLER_REDIRECT_URL =
  "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/installer.exe?token=test-token";

export const TEST_LIMITS = Object.freeze({
  requestTimeoutMs: 1000,
  retries: 0,
  retryDelayMs: 0,
});

export const FIXED_NOW = 1_800_000_000_000;

export const DEFAULT_INSTALLER_BYTES = Buffer.from(
  Array.from({ length: 2048 }, (_, index) => (index * 7 + 3) % 256),
);

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function createTempBaseDirectory() {
  const baseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ytvw-update-corpus-"),
  );
  return {
    baseDirectory,
    cleanup() {
      fs.rmSync(baseDirectory, { recursive: true, force: true });
    },
  };
}

export function createTestKeypair(keyId = "test-key-a") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spkiBase64 = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return {
    keyId,
    keyring: { keys: [{ keyId, status: "active", spkiBase64 }] },
    privateKey,
    signBytes(bytes) {
      return crypto.sign(null, bytes, privateKey).toString("base64");
    },
  };
}

export function createManifest({
  installerBytes = DEFAULT_INSTALLER_BYTES,
  keyId = "test-key-a",
  ...overrides
} = {}) {
  return {
    schemaVersion: 1,
    keyId,
    channel: "stable",
    version: "2.0.0",
    releaseTag: "v2.0.0",
    installerAssetName: INSTALLER_ASSET_NAME,
    size: installerBytes.length,
    sha256: sha256Hex(installerBytes),
    minBootstrapVersion: "1.0.0",
    minAppVersion: "1.0.0",
    ...overrides,
  };
}

export function createRelease({
  tagName = "v2.0.0",
  includeManifestAsset = true,
  includeSignatureAsset = true,
  installerAssetName = INSTALLER_ASSET_NAME,
  manifestAssetUrl = MANIFEST_ASSET_URL,
  signatureAssetUrl = SIGNATURE_ASSET_URL,
  installerAssetUrl = INSTALLER_ASSET_URL,
  extraAssets = [],
  ...overrides
} = {}) {
  const assets = [];
  if (includeManifestAsset) {
    assets.push({ name: UPDATE_MANIFEST_ASSET_NAME, url: manifestAssetUrl });
  }
  if (includeSignatureAsset) {
    assets.push({ name: UPDATE_SIGNATURE_ASSET_NAME, url: signatureAssetUrl });
  }
  if (installerAssetName !== null) {
    assets.push({ name: installerAssetName, url: installerAssetUrl });
  }
  assets.push(...extraAssets);
  return {
    tag_name: tagName,
    draft: false,
    prerelease: false,
    url: `https://api.github.com/repos/${REPOSITORY}/releases/1`,
    html_url: `https://github.com/${REPOSITORY}/releases/tag/${tagName}`,
    assets,
    ...overrides,
  };
}

/** Serves the manifest pretty-printed with reversed keys. */
export function prettyManifestText(manifest) {
  const reversed = {};
  for (const key of Object.keys(manifest).reverse()) {
    reversed[key] = manifest[key];
  }
  return JSON.stringify(reversed, null, 2);
}

export function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function bytesResponse(bytes, { status = 200, headers = {} } = {}) {
  return new Response(bytes, { status, headers });
}

export function redirectResponse(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

export function errorResponse(status, headers = {}) {
  return new Response("error", { status, headers });
}

/**
 * Records every request and delegates to `responder(url, call, fixture)`.
 * The responder must return a `Response` or throw.
 */
export function createTransport(responder) {
  const calls = [];
  const transport = async (url, init) => {
    const call = {
      url,
      init,
      headers: { ...(init?.headers ?? {}) },
    };
    calls.push(call);
    return responder(url, call, calls.length - 1);
  };
  return { transport, calls };
}

/**
 * Builds a complete happy-path scenario. Every adversarial case is expressed
 * as an override of this fixture, which keeps the corpus honest: one mutation
 * per case, everything else valid.
 */
export function buildScenario(options = {}) {
  const temp = createTempBaseDirectory();
  const keyPair = createTestKeypair(options.keyId ?? "test-key-a");
  const installerBytes = options.installerBytes ?? DEFAULT_INSTALLER_BYTES;
  const manifest = createManifest({
    installerBytes,
    keyId: keyPair.keyId,
    ...(options.manifestOverrides ?? {}),
  });
  for (const key of options.omitManifestKeys ?? []) {
    delete manifest[key];
  }
  const canonicalText = canonicalJsonText(manifest);
  const manifestText =
    options.manifestText === undefined
      ? prettyManifestText(manifest)
      : options.manifestText(manifest);
  const signatureBase64 =
    options.signatureBase64 === undefined
      ? keyPair.signBytes(Buffer.from(canonicalText, "utf8"))
      : options.signatureBase64({
          manifest,
          canonicalText,
          keyPair,
          installerBytes,
        });
  const release = createRelease({
    tagName: manifest.releaseTag,
    installerAssetName: manifest.installerAssetName,
    ...(options.releaseOptions ?? {}),
    ...(options.releaseOverrides ?? {}),
  });

  const fixture = {
    baseDirectory: temp.baseDirectory,
    cleanup: temp.cleanup,
    keyPair,
    keyring: options.keyring ?? keyPair.keyring,
    installerBytes,
    manifest,
    canonicalText,
    manifestText,
    signatureBase64,
    release,
    currentVersion: options.currentVersion ?? "1.0.0",
    appVersion: options.appVersion ?? "1.0.0",
    bootstrapVersion: options.bootstrapVersion ?? "1.0.0",
    limits: { ...TEST_LIMITS, ...(options.limits ?? {}) },
    now: options.now ?? (() => FIXED_NOW),
    etagCache: options.etagCache ?? createMemoryEtagCache(),
  };

  if (options.transport !== undefined) {
    fixture.transport = options.transport(fixture);
  } else {
    const responder =
      options.respond ??
      ((url) => {
        const override = options.responses?.[url];
        if (override !== undefined) {
          return typeof override === "function" ? override(fixture) : override;
        }
        if (url === RELEASES_LATEST_URL) {
          return jsonResponse(fixture.release, {
            headers: { etag: '"release-etag-1"' },
          });
        }
        if (url === MANIFEST_ASSET_URL) {
          return bytesResponse(Buffer.from(fixture.manifestText, "utf8"));
        }
        if (url === SIGNATURE_ASSET_URL) {
          // Trailing newline proves the verifier tolerates whitespace.
          return bytesResponse(
            Buffer.from(`${fixture.signatureBase64}\n`, "utf8"),
          );
        }
        if (url === INSTALLER_ASSET_URL) {
          return redirectResponse(INSTALLER_REDIRECT_URL);
        }
        if (url === INSTALLER_REDIRECT_URL) {
          return bytesResponse(fixture.installerBytes);
        }
        throw new Error(`unexpected request URL: ${url}`);
      });
    const recording = createTransport((url, call, index) =>
      responder(url, call, index, fixture),
    );
    fixture.transport = recording.transport;
    fixture.calls = recording.calls;
  }
  if (fixture.calls === undefined) {
    fixture.calls = [];
  }

  return fixture;
}

/** Snapshot of on-disk update state for cleanup assertions. */
export function readUpdateState(baseDirectory) {
  const paths = updateHomePaths(baseDirectory);
  return {
    lockExists: fs.existsSync(paths.lockPath),
    pendingDirectories: fs.existsSync(paths.pendingRoot)
      ? fs.readdirSync(paths.pendingRoot)
      : [],
  };
}

/** A transport that rejects only when the request's timeout aborts it. */
export function createAbortTransport() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });
}

/** Plants a lock file with an explicit payload and optional mtime age. */
export function plantLockFile(
  baseDirectory,
  { acquiredAt = FIXED_NOW, pid = 4242, ageMs = 0 } = {},
) {
  const paths = updateHomePaths(baseDirectory);
  fs.mkdirSync(paths.home, { recursive: true });
  fs.writeFileSync(paths.lockPath, JSON.stringify({ pid, acquiredAt }), "utf8");
  if (ageMs > 0) {
    const timestamp = (Date.now() - ageMs) / 1000;
    fs.utimesSync(paths.lockPath, timestamp, timestamp);
  }
  return paths.lockPath;
}
