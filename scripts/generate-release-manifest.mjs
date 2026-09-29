/**
 * Generates and signs the update release manifest.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNING CONTRACT (must match src/main/update exactly)
 * ---------------------------------------------------------------------------
 * The signed payload is `canonicalBytes(toSignableJson(manifest))` -- the
 * canonical UTF-8 form of the ten-field manifest object, never the bytes
 * written to disk. The file on disk is pretty-printed on purpose: the app
 * re-serializes the parsed object canonically before verifying, so a
 * reordered or re-indented manifest still verifies, while any change to a
 * semantic value fails closed with `invalid-signature`.
 *
 * This generator imports the app's own canonical serializer, schema, and
 * verification path rather than reimplementing them, so the signer cannot
 * drift from the verifier. Only `node:` builtins and the application's own
 * modules are used: there is no third-party dependency.
 *
 * There is no private key material in this repository. The production key is
 * read from the `RELEASE_ED25519_PRIVATE_KEY` Actions secret, which only the
 * protected `release` environment can reach.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalBytes } from "../src/main/update/canonical.ts";
import { checkForUpdate } from "../src/main/update/check-for-update.ts";
import { createMemoryEtagCache } from "../src/main/update/discovery.ts";
import {
  KEYRING_PLACEHOLDER,
  PRODUCTION_KEYRING,
} from "../src/main/update/keyring.ts";
import {
  SUPPORTED_SCHEMA_VERSION,
  UPDATE_MANIFEST_ASSET_NAME,
  UPDATE_SIGNATURE_ASSET_NAME,
  parseUpdateManifest,
  toSignableJson,
} from "../src/main/update/manifest-schema.ts";
import { updateHomePaths } from "../src/main/update/pending.ts";
import { ALLOWED_UPDATE_CHANNEL } from "../src/main/update/policy.ts";
import {
  GITHUB_API_HOST,
  GITHUB_RELEASES_LATEST_URL,
  GITHUB_REPOSITORY,
} from "../src/main/update/redirect-policy.ts";
import { isStableVersion, parseSemver } from "../src/main/update/version.ts";

const PRODUCT_NAME = "youtubetv-for-windows";
const UPDATE_CHECKSUM_ASSET_NAME = "update-manifest.sha256";
const ACTIVE_RELEASE_KEY_ID = "ytvw-release-primary";
const NEXT_RELEASE_KEY_ID = "ytvw-release-next";
const APPROVED_RELEASE_KEY_IDS = new Set([
  ACTIVE_RELEASE_KEY_ID,
  NEXT_RELEASE_KEY_ID,
]);
const API_RELEASE_URL = `https://${GITHUB_API_HOST}/repos/${GITHUB_REPOSITORY}/releases/1`;
const DRY_RUN_VERSION = "0.1.0";
/** Version assumed installed, so the generated manifest must read as newer. */
const CURRENT_VERSION = "0.0.0";
const TEST_INSTALLER_BYTES = Buffer.from(
  Array.from({ length: 2048 }, (_unused, index) => (index * 29 + 17) % 256),
);

function fail(message) {
  throw new Error(message);
}

function parseArguments(tokens) {
  const options = { verify: false, dryRun: false, verifyOnly: false };
  const valueOptions = new Set([
    "installer",
    "release-directory",
    "version",
    "release-tag",
    "key-id",
    "min-bootstrap-version",
    "min-app-version",
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--verify") {
      options.verify = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--verify-only") {
      options.verifyOnly = true;
      continue;
    }
    if (!token.startsWith("--") || !valueOptions.has(token.slice(2))) {
      fail(`unknown option ${token}`);
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${token} requires a value`);
    }
    const name = token
      .slice(2)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (options[name] !== undefined) {
      fail(`${token} was provided more than once`);
    }
    options[name] = value;
    index += 1;
  }

  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(
      `--${name.replace(
        /[A-Z]/g,
        (letter) => `-${letter.toLowerCase()}`,
      )} is required`,
    );
  }
  return value;
}

function assertStableReleaseIdentity(version, releaseTag, installerAssetName) {
  const parsedVersion = parseSemver(version);
  if (parsedVersion === undefined || !isStableVersion(parsedVersion)) {
    fail("--version must be a stable semantic version");
  }
  if (releaseTag !== `v${version}`) {
    fail("--release-tag must exactly equal v<version>");
  }
  const expectedInstallerAssetName = `${PRODUCT_NAME}-${version}-x64.exe`;
  if (installerAssetName !== expectedInstallerAssetName) {
    fail(`installer name must be ${expectedInstallerAssetName}`);
  }
}

function assertMinimumVersion(value, optionName) {
  if (parseSemver(value) === undefined) {
    fail(`${optionName} must be a semantic version`);
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * The signing directory must hold the installer and nothing else, so a stale
 * or unexpected byproduct can never end up in the signed asset set.
 */
function assertReleaseDirectory(installerPath, releaseDirectory) {
  const resolvedInstallerPath = resolve(installerPath);
  const resolvedReleaseDirectory = resolve(releaseDirectory);
  if (dirname(resolvedInstallerPath) !== resolvedReleaseDirectory) {
    fail("--installer must be inside --release-directory");
  }
  const installerStats = statSync(resolvedInstallerPath);
  if (!installerStats.isFile() || installerStats.size < 1) {
    fail("--installer must name a non-empty regular file");
  }
  if (!Number.isSafeInteger(installerStats.size)) {
    fail("installer size exceeds the safe integer range");
  }
  const entries = readdirSync(resolvedReleaseDirectory).sort();
  if (
    JSON.stringify(entries) !==
    JSON.stringify([basename(resolvedInstallerPath)])
  ) {
    fail("--release-directory must contain only the installer before signing");
  }
  return { installerPath: resolvedInstallerPath, size: installerStats.size };
}

function keyringForPrivateKey(privateKey, keyId) {
  return {
    keys: [
      {
        keyId,
        status: keyId === ACTIVE_RELEASE_KEY_ID ? "active" : "next",
        spkiBase64: createPublicKey(privateKey)
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      },
    ],
  };
}

/**
 * Fails closed unless the keyring entry a release would be signed with is a
 * real public key. `keyring.ts` ships `REPLACE_BEFORE_RELEASE` placeholders by
 * design, so signing and verification both refuse to proceed until a maintainer
 * has embedded the real public keys (see docs/release-signing-runbook.md).
 */
function assertKeyringProvisioned(keyId) {
  if (!APPROVED_RELEASE_KEY_IDS.has(keyId)) {
    fail("--key-id is not an approved active/next release key ID");
  }
  const configuredKey = PRODUCTION_KEYRING.keys.find(
    (candidate) => candidate.keyId === keyId,
  );
  if (configuredKey === undefined) {
    fail("the selected key ID is absent from the application keyring");
  }
  if (configuredKey.spkiBase64 === KEYRING_PLACEHOLDER) {
    fail(
      "the application keyring still holds REPLACE_BEFORE_RELEASE placeholders; ship a launcher with the real public keys first",
    );
  }
  return PRODUCTION_KEYRING;
}

/**
 * Fails closed unless the supplied private key matches the public key the
 * shipped launcher trusts. The signing key is never enough on its own: a key
 * that the keyring does not carry would produce a release no installation can
 * verify.
 */
function assertProductionSigningKey(privateKey, keyId) {
  const keyring = assertKeyringProvisioned(keyId);
  const configuredKey = keyring.keys.find(
    (candidate) => candidate.keyId === keyId,
  );
  const suppliedPublicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  if (
    configuredKey === undefined ||
    suppliedPublicKey !== configuredKey.spkiBase64
  ) {
    fail(
      "the protected signing key does not match the embedded public keyring",
    );
  }
  return keyring;
}

function createManifest({
  keyId,
  version,
  releaseTag,
  installerAssetName,
  size,
  sha256,
  minBootstrapVersion,
  minAppVersion,
}) {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    keyId,
    channel: ALLOWED_UPDATE_CHANNEL,
    version,
    releaseTag,
    installerAssetName,
    size,
    sha256,
    minBootstrapVersion,
    minAppVersion,
  };
}

function expectedAssetNames(installerAssetName) {
  return [
    installerAssetName,
    UPDATE_MANIFEST_ASSET_NAME,
    UPDATE_SIGNATURE_ASSET_NAME,
    UPDATE_CHECKSUM_ASSET_NAME,
  ].sort();
}

function assertAssetSet(releaseDirectory, installerAssetName) {
  const actual = readdirSync(releaseDirectory).sort();
  const expected = expectedAssetNames(installerAssetName);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `release assets must be exactly ${expected.join(", ")} (found ${actual.join(
        ", ",
      )})`,
    );
  }
}

function generateReleaseArtifacts({
  installerPath,
  releaseDirectory,
  version,
  releaseTag,
  keyId,
  minBootstrapVersion,
  minAppVersion,
  privateKey,
}) {
  const installerAssetName = basename(installerPath);
  assertStableReleaseIdentity(version, releaseTag, installerAssetName);
  assertMinimumVersion(minBootstrapVersion, "--min-bootstrap-version");
  assertMinimumVersion(minAppVersion, "--min-app-version");
  const installer = assertReleaseDirectory(installerPath, releaseDirectory);
  const manifest = createManifest({
    keyId,
    version,
    releaseTag,
    installerAssetName,
    size: installer.size,
    sha256: sha256File(installer.installerPath),
    minBootstrapVersion,
    minAppVersion,
  });
  const canonicalManifestBytes = canonicalBytes(toSignableJson(manifest));
  const signatureBase64 = signEd25519(
    null,
    canonicalManifestBytes,
    privateKey,
  ).toString("base64");
  const manifestPath = join(releaseDirectory, UPDATE_MANIFEST_ASSET_NAME);
  const signaturePath = join(releaseDirectory, UPDATE_SIGNATURE_ASSET_NAME);
  const checksumPath = join(releaseDirectory, UPDATE_CHECKSUM_ASSET_NAME);

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(signaturePath, `${signatureBase64}\n`, "utf8");
  writeFileSync(
    checksumPath,
    `${manifest.sha256}  ${manifest.installerAssetName}\n`,
    "utf8",
  );
  assertAssetSet(releaseDirectory, installerAssetName);

  return {
    manifest,
    manifestPath,
    signaturePath,
    checksumPath,
    releaseDirectory,
  };
}

/**
 * Serves the generated assets from memory over `api.github.com`, exactly as a
 * published release would answer. No socket is opened: the launcher only ever
 * reaches a transport through its injected seam, and the redirect policy
 * accepts a direct 200 from the one allowed host.
 */
function createOfflineReleaseFeed(artifacts, manifest) {
  const bodies = new Map([
    [UPDATE_MANIFEST_ASSET_NAME, readFileSync(artifacts.manifestPath)],
    [UPDATE_SIGNATURE_ASSET_NAME, readFileSync(artifacts.signaturePath)],
    [UPDATE_CHECKSUM_ASSET_NAME, readFileSync(artifacts.checksumPath)],
    [
      manifest.installerAssetName,
      readFileSync(
        join(artifacts.releaseDirectory, manifest.installerAssetName),
      ),
    ],
  ]);

  const responses = new Map();
  const assets = [];
  let assetId = 0;
  for (const name of [...bodies.keys()].sort()) {
    assetId += 1;
    const url = `${API_RELEASE_URL}/assets/${assetId}`;
    assets.push({ name, url });
    responses.set(url, bodies.get(name));
  }
  responses.set(
    GITHUB_RELEASES_LATEST_URL,
    Buffer.from(
      JSON.stringify({
        tag_name: manifest.releaseTag,
        url: API_RELEASE_URL,
        html_url: `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${manifest.releaseTag}`,
        draft: false,
        prerelease: false,
        assets,
      }),
      "utf8",
    ),
  );

  const requested = [];
  const transport = async (input) => {
    requested.push(input);
    const body = responses.get(new URL(input).href);
    if (body === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
      },
    });
  };

  return {
    transport,
    requested,
    assetNames: assets.map((asset) => asset.name),
  };
}

/**
 * Runs the application's real, unmodified update pipeline against the bytes
 * that are about to be uploaded: release discovery, manifest and signature
 * download, strict parse, detached Ed25519 verification over the canonical
 * bytes, version/binding policy, and the streamed size-and-hash verified
 * installer download. Returns the pipeline result for the caller to inspect.
 */
async function verifyGeneratedArtifacts(artifacts, keyring) {
  const feed = createOfflineReleaseFeed(artifacts, artifacts.manifest);
  const baseDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-verify-"));
  try {
    const result = await checkForUpdate({
      transport: feed.transport,
      currentVersion: CURRENT_VERSION,
      appVersion: artifacts.manifest.minAppVersion,
      bootstrapVersion: artifacts.manifest.minBootstrapVersion,
      keyring,
      baseDirectory,
      etagCache: createMemoryEtagCache(),
      now: () => Date.now(),
    });
    if (result.kind !== "update-ready") {
      const reason =
        result.kind === "up-to-date"
          ? "the manifest read as not newer than the installed version"
          : `${result.code}: ${result.message}`;
      fail(`the application rejected the generated release (${reason})`);
    }

    for (const [field, expected] of Object.entries(artifacts.manifest)) {
      const actual = result.manifest[field];
      if (actual !== expected) {
        fail(
          `the verified manifest field ${field} is ${String(actual)}, expected ${String(expected)}`,
        );
      }
    }

    const verifiedBytes = readFileSync(result.installerPath);
    const originalBytes = readFileSync(
      join(artifacts.releaseDirectory, artifacts.manifest.installerAssetName),
    );
    if (!verifiedBytes.equals(originalBytes)) {
      fail(
        "the installer delivered to the pending directory is not byte-identical",
      );
    }
    if (
      createHash("sha256").update(verifiedBytes).digest("hex") !==
      artifacts.manifest.sha256
    ) {
      fail("the verified installer does not hash to the signed SHA-256");
    }

    const expectedChecksum = `${artifacts.manifest.sha256}  ${artifacts.manifest.installerAssetName}\n`;
    if (readFileSync(artifacts.checksumPath, "utf8") !== expectedChecksum) {
      fail(
        "the generated checksum does not bind the installer name and SHA-256",
      );
    }
    assertAssetSet(
      artifacts.releaseDirectory,
      artifacts.manifest.installerAssetName,
    );
    const expectedReleaseAssets = expectedAssetNames(
      artifacts.manifest.installerAssetName,
    );
    if (
      JSON.stringify(feed.assetNames) !== JSON.stringify(expectedReleaseAssets)
    ) {
      fail(
        `the release advertises ${feed.assetNames.join(", ")} instead of ${expectedReleaseAssets.join(", ")}`,
      );
    }
    removeVerifiedState(baseDirectory, result.nonce);

    return { assetNames: feed.assetNames, requests: feed.requested.length };
  } finally {
    rmSync(baseDirectory, { recursive: true, force: true });
  }
}

function removeVerifiedState(baseDirectory, nonce) {
  rmSync(join(updateHomePaths(baseDirectory).pendingRoot, nonce), {
    recursive: true,
    force: true,
  });
}

function loadProtectedPrivateKey() {
  const serializedKey = process.env.RELEASE_ED25519_PRIVATE_KEY;
  if (typeof serializedKey !== "string" || serializedKey.trim() === "") {
    fail("RELEASE_ED25519_PRIVATE_KEY is required for release signing");
  }
  try {
    return createPrivateKey(serializedKey);
  } catch {
    fail(
      "RELEASE_ED25519_PRIVATE_KEY could not be parsed as an Ed25519 private key",
    );
  }
}

/**
 * Re-verifies an already-signed, staged release directory without touching the
 * private key. This is the publication gate: it runs immediately before upload
 * and proves that the bytes about to be published are the bytes the signature
 * covers. Only public keyring material is read, so the step that runs it needs
 * no secret at all.
 */
async function runVerifyOnly(options) {
  const releaseDirectory = requireOption(options, "releaseDirectory");
  const version = requireOption(options, "version");
  const releaseTag = requireOption(options, "releaseTag");
  const keyId = requireOption(options, "keyId");
  const keyring = assertKeyringProvisioned(keyId);

  const manifestPath = join(releaseDirectory, UPDATE_MANIFEST_ASSET_NAME);
  const parsed = parseUpdateManifest(readFileSync(manifestPath, "utf8"));
  if (!parsed.ok) {
    fail(`the staged manifest is rejected by the application: ${parsed.code}`);
  }
  const manifest = parsed.manifest;
  assertStableReleaseIdentity(version, releaseTag, manifest.installerAssetName);
  if (manifest.keyId !== keyId) {
    fail(
      `the staged manifest is bound to ${manifest.keyId}, not the requested ${keyId}`,
    );
  }
  const artifacts = {
    manifest,
    manifestPath,
    signaturePath: join(releaseDirectory, UPDATE_SIGNATURE_ASSET_NAME),
    checksumPath: join(releaseDirectory, UPDATE_CHECKSUM_ASSET_NAME),
    releaseDirectory,
  };
  const verification = await verifyGeneratedArtifacts(artifacts, keyring);
  process.stdout.write(
    `[release-manifest] staged assets verified against the application update pipeline: ${verification.assetNames.join(", ")}\n`,
  );
}

async function runProduction(options) {
  const privateKey = loadProtectedPrivateKey();
  const keyId = requireOption(options, "keyId");
  const keyring = assertProductionSigningKey(privateKey, keyId);
  const artifacts = generateReleaseArtifacts({
    installerPath: requireOption(options, "installer"),
    releaseDirectory: requireOption(options, "releaseDirectory"),
    version: requireOption(options, "version"),
    releaseTag: requireOption(options, "releaseTag"),
    keyId,
    minBootstrapVersion: requireOption(options, "minBootstrapVersion"),
    minAppVersion: requireOption(options, "minAppVersion"),
    privateKey,
  });
  const assetNames = expectedAssetNames(artifacts.manifest.installerAssetName);
  if (!options.verify) {
    process.stdout.write(
      `[release-manifest] generated ${assetNames.join(", ")}\n`,
    );
    return;
  }
  await verifyGeneratedArtifacts(artifacts, keyring);
  process.stdout.write(
    `[release-manifest] generated ${assetNames.join(", ")} and verified them through the application update pipeline\n`,
  );
}

/**
 * Hermetic proof with a throwaway key: nothing here touches the network, the
 * GitHub API, or any real key. The ephemeral key never reaches a release
 * environment, so the production `PRODUCTION_KEYRING` placeholder guard is
 * deliberately not involved.
 */
async function runDryRun() {
  const version = DRY_RUN_VERSION;
  const releaseDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-dry-run-"));
  const installerAssetName = `${PRODUCT_NAME}-${version}-x64.exe`;
  const installerPath = join(releaseDirectory, installerAssetName);
  const { privateKey } = generateKeyPairSync("ed25519");
  try {
    writeFileSync(installerPath, TEST_INSTALLER_BYTES);
    const artifacts = generateReleaseArtifacts({
      installerPath,
      releaseDirectory,
      version,
      releaseTag: `v${version}`,
      keyId: ACTIVE_RELEASE_KEY_ID,
      minBootstrapVersion: version,
      minAppVersion: version,
      privateKey,
    });
    const verification = await verifyGeneratedArtifacts(
      artifacts,
      keyringForPrivateKey(privateKey, ACTIVE_RELEASE_KEY_ID),
    );
    process.stdout.write(
      [
        "[release-manifest] local non-production dry run passed.",
        `key: ephemeral Ed25519 (keyId ${ACTIVE_RELEASE_KEY_ID}), never a production key`,
        "verified through the real application update pipeline:",
        "  checkForUpdate -> discoverLatestRelease -> parseUpdateManifest ->",
        "  verifyManifestSignature over canonical bytes -> evaluateUpdatePolicy ->",
        "  downloadVerifiedInstaller (result: update-ready)",
        `requests served from the in-memory api.github.com feed: ${verification.requests}`,
        "release assets (exactly four, as advertised by the simulated release):",
        ...verification.assetNames.map((name) => `  - ${name}`),
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(releaseDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.dryRun) {
    if (process.argv.length !== 3) {
      fail("--dry-run cannot be combined with production options");
    }
    await runDryRun();
    return;
  }
  if (options.verifyOnly) {
    if (options.verify) {
      fail("--verify-only cannot be combined with --verify");
    }
    await runVerifyOnly(options);
    return;
  }
  await runProduction(options);
}

main().catch((error) => {
  process.stderr.write(
    `[release-manifest] ${
      error instanceof Error ? error.message : "release signing failed"
    }\n`,
  );
  process.exitCode = 1;
});
