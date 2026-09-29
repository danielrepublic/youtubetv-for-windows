import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalBytes } from "../../src/main/update/canonical.ts";
import { checkForUpdate } from "../../src/main/update/check-for-update.ts";
import { createMemoryEtagCache } from "../../src/main/update/discovery.ts";
import { verifyInstallerFile } from "../../src/main/update/installer.ts";
import {
  parseUpdateManifest,
  toSignableJson,
} from "../../src/main/update/manifest-schema.ts";
import { verifyManifestSignature } from "../../src/main/update/signature.ts";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
// CI always reads the committed workflow. The environment variable is an
// evidence-only seam so an external driver can run this same suite against a
// mutant copy in a scratch directory without editing the repository.
const workflowPath =
  process.env.YTVW_RELEASE_WORKFLOW_PATH ??
  join(repositoryRoot, ".github", "workflows", "release.yml");
const generatorPath = join(
  repositoryRoot,
  "scripts",
  "generate-release-manifest.mjs",
);
const generatorText = readFileSync(generatorPath, "utf8");
const expectedAssets = [
  '"release-assets/$installer"',
  "release-assets/update-manifest.json",
  "release-assets/update-manifest.sig",
  "release-assets/update-manifest.sha256",
];
const SIGNING_STEP = "Sign the exact upload asset set";
const REVERIFY_STEP = "Re-verify the staged assets immediately before upload";
const PUBLISH_STEP = "Publish immutable GitHub Release assets";
const API_RELEASE_URL =
  "https://api.github.com/repos/danielrepublic/youtubetv-for-windows/releases/1";
const RELEASES_LATEST_URL =
  "https://api.github.com/repos/danielrepublic/youtubetv-for-windows/releases/latest";
const actionPins = [
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38", "v6.5.0"],
  [
    "actions/upload-artifact",
    "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "v7.0.1",
  ],
];

function failureIf(condition, message, failures) {
  if (condition) {
    failures.push(message);
  }
}

function hasExactToken(source, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(source);
}

function jobBody(source, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const followingJobs = source
    .slice(start + marker.length)
    .search(/\n {2}\w+:\n/);
  return followingJobs < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + followingJobs);
}

function secretAppearsInRunBlock(source) {
  let runIndentation;
  for (const line of source.split(/\r?\n/)) {
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (runIndentation !== undefined && line.trim() !== "") {
      if (indentation <= runIndentation) {
        runIndentation = undefined;
      } else if (line.includes("secrets.")) {
        return true;
      }
    }
    const run = /^(\s*)run:\s*(.*)$/.exec(line);
    if (run === null) {
      continue;
    }
    if (run[2].includes("secrets.")) {
      return true;
    }
    runIndentation = /^[>|]/.test(run[2].trim()) ? run[1].length : undefined;
  }
  return false;
}

function stepBlock(source, name) {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const followingStep = source.slice(start + marker.length).search(/\n {6}- /);
  return followingStep < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + followingStep);
}

function validateReleaseWorkflow(source) {
  const failures = [];
  const publish = jobBody(source, "publish");

  failureIf(
    !/on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"/.test(source),
    "release workflow must use a version-tag-only push trigger",
    failures,
  );
  failureIf(
    /\n\s*(?:pull_request|pull_request_target|workflow_run|workflow_dispatch):/.test(
      source,
    ),
    "release workflow must not accept pull-request or manual ref-triggered events",
    failures,
  );
  failureIf(
    !/^permissions: \{\}$/m.test(source),
    "workflow permissions must default to none",
    failures,
  );
  failureIf(
    publish === undefined ||
      !/github\.event_name == 'push' && github\.ref_type == 'tag' &&\s+github\.ref_protected && startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(
        publish,
      ) ||
      !/environment:\s*\n\s+name: release/.test(publish) ||
      !/permissions:\s*\n\s+contents: write/.test(publish),
    "publish must require a protected release environment and protected tag ref",
    failures,
  );
  failureIf(
    publish === undefined ||
      !/RELEASE_ED25519_PRIVATE_KEY: \$\{\{ secrets\.RELEASE_ED25519_PRIVATE_KEY \}\}/.test(
        publish,
      ),
    "publish must reference exactly the protected RELEASE_ED25519_PRIVATE_KEY secret",
    failures,
  );
  const signingSecretReferences = source.match(
    /secrets\.RELEASE_ED25519_PRIVATE_KEY/g,
  );
  failureIf(
    signingSecretReferences?.length !== 1,
    "the signing secret may appear exactly once",
    failures,
  );
  failureIf(
    secretAppearsInRunBlock(source) ||
      /(?:Write-Host|echo|cat|Get-Content|base64)[^\r\n]*RELEASE_ED25519_PRIVATE_KEY/i.test(
        source,
      ),
    "workflow steps must never print the signing secret",
    failures,
  );
  failureIf(
    publish === undefined ||
      !/gh release view \$env:GITHUB_REF_NAME/.test(publish) ||
      !/Refusing to overwrite existing release/.test(publish) ||
      !/gh release create \$env:GITHUB_REF_NAME/.test(publish),
    "publish must refuse an existing release version before creation",
    failures,
  );
  failureIf(
    publish === undefined ||
      expectedAssets.some((asset) => !hasExactToken(publish, asset)) ||
      /gh release create[^\r\n]*\*/.test(publish),
    "publish asset set must be exactly installer, manifest, signature, and checksum",
    failures,
  );
  for (const [action, sha, version] of actionPins) {
    failureIf(
      !source.includes(`uses: ${action}@${sha} # ${version}`),
      `${action} must use the documented immutable ${version} commit SHA`,
      failures,
    );
  }
  const actionReferences = [...source.matchAll(/^\s+uses:\s+\S+@([^\s#]+)/gm)];
  failureIf(
    actionReferences.some((match) => !/^[0-9a-f]{40}$/.test(match[1])),
    "every action must be pinned to a full commit SHA",
    failures,
  );

  const signingIndex = source.indexOf(`      - name: ${SIGNING_STEP}\n`);
  const reverifyIndex = source.indexOf(`      - name: ${REVERIFY_STEP}\n`);
  const publishIndex = source.indexOf(`      - name: ${PUBLISH_STEP}\n`);
  const reverifyStep = stepBlock(source, REVERIFY_STEP);
  failureIf(
    signingIndex < 0 ||
      !(reverifyIndex > signingIndex && publishIndex > reverifyIndex),
    "the staged assets must be re-verified after signing and before publication",
    failures,
  );
  failureIf(
    reverifyStep === undefined || !/--verify-only/.test(reverifyStep),
    "the pre-upload re-verification must run the generator in --verify-only mode",
    failures,
  );
  failureIf(
    reverifyStep === undefined || reverifyStep.includes("secrets."),
    "the pre-upload re-verification step must not receive the signing secret",
    failures,
  );

  const keyIdMatch = /--key-id ([A-Za-z0-9_-]+)/.exec(source);
  const activeKeyMatch = /keyId: "([^"]+)",\s*\n\s+status: "active"/.exec(
    readFileSync(
      join(repositoryRoot, "src", "main", "update", "keyring.ts"),
      "utf8",
    ),
  );
  failureIf(
    keyIdMatch === null ||
      activeKeyMatch === null ||
      keyIdMatch[1] !== activeKeyMatch[1],
    "the workflow must sign with the keyring's active release key",
    failures,
  );

  failureIf(
    !/## 繁體中文/.test(source) ||
      !/## English/.test(source) ||
      !/--notes-file/.test(source),
    "release notes must be bilingual and supplied from a notes file",
    failures,
  );

  return failures;
}

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  assert.notEqual(
    index,
    -1,
    `scratch mutation precondition missing: ${before}`,
  );
  return `${source.slice(0, index)}${after}${source.slice(
    index + before.length,
  )}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Serves a signed release over the application's injected transport exactly as
 * a published GitHub release would answer. No socket is opened; the redirect
 * policy accepts a direct HTTPS 200 from the one allowed host.
 */
function createOfflineReleaseFeed({
  manifest,
  signatureBase64,
  checksumText,
  installerBytes,
  advertisedAssets,
}) {
  const assetBodies = {
    "update-manifest.json": Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    "update-manifest.sig": Buffer.from(`${signatureBase64}\n`, "utf8"),
    "update-manifest.sha256": Buffer.from(checksumText, "utf8"),
    [manifest.installerAssetName]: installerBytes,
  };
  const assets = advertisedAssets.map((name, index) => ({
    name,
    url: `${API_RELEASE_URL}/assets/${index + 1}`,
  }));
  const responses = new Map();
  for (const asset of assets) {
    const body = assetBodies[asset.name];
    if (body !== undefined) {
      responses.set(asset.url, body);
    }
  }
  responses.set(
    RELEASES_LATEST_URL,
    Buffer.from(
      JSON.stringify({
        tag_name: manifest.releaseTag,
        url: API_RELEASE_URL,
        html_url: `https://github.com/danielrepublic/youtubetv-for-windows/releases/tag/${manifest.releaseTag}`,
        draft: false,
        prerelease: false,
        assets,
      }),
      "utf8",
    ),
  );
  return async (input) => {
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
}

test("the release workflow keeps the protected tag, secret, action, and asset policy", () => {
  const failures = validateReleaseWorkflow(readFileSync(workflowPath, "utf8"));
  assert.deepEqual(failures, []);
});

test("the generator signs the application's canonical bytes and never prints key material", () => {
  // The signer must reuse the verifier's own serializer; a private
  // reimplementation is exactly how a signer drifts from what ships.
  assert.match(
    generatorText,
    /import \{ canonicalBytes \} from "\.\.\/src\/main\/update\/canonical\.ts"/,
  );
  assert.match(
    generatorText,
    /toSignableJson[\s\S]*?from "\.\.\/src\/main\/update\/manifest-schema\.ts"/,
  );
  assert.match(
    generatorText,
    /canonicalBytes\(toSignableJson\(/,
    "the signature must cover the canonical bytes, not the pretty-printed file",
  );
  assert.match(generatorText, /checkForUpdate/);
  assert.doesNotMatch(
    generatorText,
    /console\.log/,
    "the generator must not print anything at all",
  );
  for (const write of generatorText.match(
    /process\.stdout\.write\([\s\S]*?\);/g,
  ) ?? []) {
    assert.doesNotMatch(
      write,
      /RELEASE_ED25519_PRIVATE_KEY|PRIVATE KEY|privateKey/,
    );
  }
});

test("each required workflow policy defect fails in a byte-restored scratch copy", (testContext) => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-policy-"));
  const scratchWorkflow = join(scratchDirectory, "release.yml");
  const original = readFileSync(workflowPath);
  writeFileSync(scratchWorkflow, original);
  testContext.after(() => {
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  const defects = [
    {
      name: "missing signing secret reference",
      mutate: (source) =>
        replaceOnce(
          source,
          "          RELEASE_ED25519_PRIVATE_KEY: ${{ secrets.RELEASE_ED25519_PRIVATE_KEY }}\n",
          "",
        ),
      expected: /protected RELEASE_ED25519_PRIVATE_KEY secret/,
    },
    {
      name: "non-tag publish guard",
      mutate: (source) =>
        replaceOnce(
          source,
          "  publish:\n    if: >-\n      github.event_name == 'push' && github.ref_type == 'tag' &&\n      github.ref_protected && startsWith(github.ref, 'refs/tags/v')",
          "  publish:\n    if: github.event_name == 'push'",
        ),
      expected: /protected release environment and protected tag ref/,
    },
    {
      name: "unprotected tag is publishable",
      mutate: (source) =>
        replaceOnce(
          source,
          "github.ref_protected && startsWith(github.ref, 'refs/tags/v')",
          "startsWith(github.ref, 'refs/tags/v')",
        ),
      expected: /protected release environment and protected tag ref/,
    },
    {
      name: "non-tag branch trigger",
      mutate: (source) =>
        replaceOnce(
          source,
          '    tags:\n      - "v*.*.*"',
          "    branches:\n      - main",
        ),
      expected: /version-tag-only push trigger/,
    },
    {
      name: "pull request can reach the workflow",
      mutate: (source) =>
        replaceOnce(source, "on:\n", "on:\n  pull_request:\n"),
      expected: /must not accept pull-request/,
    },
    {
      name: "duplicate release command",
      mutate: (source) =>
        replaceOnce(
          source,
          "gh release view $env:GITHUB_REF_NAME",
          "gh release list $env:GITHUB_REF_NAME",
        ),
      expected: /refuse an existing release version/,
    },
    {
      name: "secret-printing log command",
      mutate: (source) =>
        `${source}\n          Write-Host $env:RELEASE_ED25519_PRIVATE_KEY\n`,
      expected: /must never print the signing secret/,
    },
    {
      name: "altered signature asset name",
      mutate: (source) =>
        replaceOnce(
          source,
          "release-assets/update-manifest.sig",
          "release-assets/update-manifest.signature",
        ),
      expected: /asset set must be exactly/,
    },
    {
      name: "missing pre-upload re-verification",
      mutate: (source) =>
        replaceOnce(
          source,
          "\n      # No secret is exposed here on purpose: this step only reads public\n      # keyring material and re-proves that the staged bytes still match the\n      # signature, so an asset altered after signing can never be published.\n      - name: Re-verify the staged assets immediately before upload\n        shell: pwsh\n        run: |\n          $version = (Get-Content package.json -Raw | ConvertFrom-Json).version\n          node scripts/generate-release-manifest.mjs --verify-only --release-directory release-assets --version $version --release-tag $env:GITHUB_REF_NAME --key-id ytvw-release-primary\n",
          "",
        ),
      expected: /must be re-verified after signing and before publication/,
    },
    {
      name: "re-verification given the signing secret",
      mutate: (source) =>
        replaceOnce(
          source,
          `      - name: ${REVERIFY_STEP}\n        shell: pwsh\n`,
          `      - name: ${REVERIFY_STEP}\n        shell: pwsh\n        env:\n          RELEASE_ED25519_PRIVATE_KEY: \${{ secrets.RELEASE_ED25519_PRIVATE_KEY }}\n`,
        ),
      expected: /must not receive the signing secret/,
    },
    {
      name: "re-verification no longer verifies",
      mutate: (source) =>
        replaceOnce(
          source,
          "--verify-only --release-directory",
          "--release-directory",
        ),
      expected: /--verify-only mode/,
    },
    {
      name: "workflow signs with a non-active key id",
      mutate: (source) =>
        replaceOnce(
          source,
          "--key-id ytvw-release-primary",
          "--key-id ytvw-release-next",
        ),
      expected: /keyring's active release key/,
    },
    {
      name: "release notes are not bilingual",
      mutate: (source) => replaceOnce(source, "          ## English\n", ""),
      expected: /bilingual/,
    },
  ];

  for (const defect of defects) {
    const before = readFileSync(scratchWorkflow);
    const beforeSha256 = sha256(before);
    try {
      writeFileSync(scratchWorkflow, defect.mutate(before.toString("utf8")));
      assert.match(
        validateReleaseWorkflow(readFileSync(scratchWorkflow, "utf8")).join(
          "\n",
        ),
        defect.expected,
        defect.name,
      );
    } finally {
      writeFileSync(scratchWorkflow, before);
    }
    const restored = readFileSync(scratchWorkflow);
    assert.equal(
      sha256(restored),
      beforeSha256,
      `${defect.name} SHA-256 restore`,
    );
    assert.deepEqual(restored, before, `${defect.name} byte-identical restore`);
  }
});

test("the generator dry run uses a non-production key and emits the required assets", () => {
  const result = spawnSync(process.execPath, [generatorPath, "--dry-run"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local non-production dry run passed/);
  for (const asset of [
    "youtubetv-for-windows-0.1.0-x64.exe",
    "update-manifest.json",
    "update-manifest.sig",
    "update-manifest.sha256",
  ]) {
    assert.match(result.stdout, new RegExp(asset.replace(/\./g, "\\.")));
  }
  assert.doesNotMatch(
    result.stdout,
    /BEGIN PRIVATE KEY|REPLACE_BEFORE_RELEASE/,
  );
});

test("an installer or manifest altered after signing fails the app's real verification code", async (testContext) => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-tamper-"));
  const installerPath = join(
    scratchDirectory,
    "youtubetv-for-windows-2.0.0-x64.exe",
  );
  const installerBytes = Buffer.from(
    "signed release installer fixture",
    "utf8",
  );
  writeFileSync(installerPath, installerBytes);
  testContext.after(() => {
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 1,
    keyId: "ytvw-release-primary",
    channel: "stable",
    version: "2.0.0",
    releaseTag: "v2.0.0",
    installerAssetName: "youtubetv-for-windows-2.0.0-x64.exe",
    size: installerBytes.length,
    sha256: sha256(installerBytes),
    minBootstrapVersion: "0.1.0",
    minAppVersion: "0.1.0",
  };
  const parsed = parseUpdateManifest(JSON.stringify(manifest));
  assert.equal(parsed.ok, true);
  const signature = sign(
    null,
    canonicalBytes(toSignableJson(parsed.manifest)),
    privateKey,
  ).toString("base64");
  const keyring = {
    keys: [
      {
        keyId: manifest.keyId,
        status: "active",
        spkiBase64: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      },
    ],
  };
  assert.deepEqual(
    verifyManifestSignature({
      keyring,
      manifest: parsed.manifest,
      signatureBase64: signature,
    }),
    { ok: true },
  );

  const alteredBytes = Buffer.from(installerBytes);
  alteredBytes[0] ^= 0x01;
  writeFileSync(installerPath, alteredBytes);
  const verification = await verifyInstallerFile({
    path: installerPath,
    expectedSize: manifest.size,
    expectedSha256: manifest.sha256,
    maxBytes: manifest.size,
  });
  assert.equal(verification.ok, false);
  assert.equal(verification.code, "installer-hash-mismatch");

  const alteredManifest = {
    ...parsed.manifest,
    size: parsed.manifest.size + 1,
  };
  const alteredVerification = verifyManifestSignature({
    keyring,
    manifest: alteredManifest,
    signatureBase64: signature,
  });
  assert.equal(alteredVerification.ok, false);
  assert.equal(alteredVerification.code, "invalid-signature");
});

test("an asset altered after signing is rejected by the full update-check pipeline", async (testContext) => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-feed-"));
  testContext.after(() => {
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  const installerBytes = Buffer.from("frozen release installer bytes", "utf8");
  const manifest = {
    schemaVersion: 1,
    keyId: "ytvw-release-primary",
    channel: "stable",
    version: "2.0.0",
    releaseTag: "v2.0.0",
    installerAssetName: "youtubetv-for-windows-2.0.0-x64.exe",
    size: installerBytes.length,
    sha256: sha256(installerBytes),
    minBootstrapVersion: "0.1.0",
    minAppVersion: "0.1.0",
  };
  const parsed = parseUpdateManifest(JSON.stringify(manifest));
  assert.equal(parsed.ok, true);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signatureBase64 = sign(
    null,
    canonicalBytes(toSignableJson(parsed.manifest)),
    privateKey,
  ).toString("base64");
  const keyring = {
    keys: [
      {
        keyId: manifest.keyId,
        status: "active",
        spkiBase64: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      },
    ],
  };
  const checksumText = `${manifest.sha256}  ${manifest.installerAssetName}\n`;
  const advertisedAssets = [
    "update-manifest.json",
    "update-manifest.sha256",
    "update-manifest.sig",
    manifest.installerAssetName,
  ];

  const runCheck = (overrides) =>
    checkForUpdate({
      transport: createOfflineReleaseFeed({
        manifest,
        signatureBase64,
        checksumText,
        installerBytes,
        advertisedAssets,
        ...overrides,
      }),
      currentVersion: "1.0.0",
      appVersion: manifest.minAppVersion,
      bootstrapVersion: manifest.minBootstrapVersion,
      keyring,
      baseDirectory: mkdtempSync(join(scratchDirectory, "base-")),
      etagCache: createMemoryEtagCache(),
      now: () => Date.now(),
    });

  const accepted = await runCheck({});
  assert.equal(accepted.kind, "update-ready", JSON.stringify(accepted));

  const alteredInstaller = Buffer.from(installerBytes);
  alteredInstaller[0] ^= 0x01;
  const installerResult = await runCheck({ installerBytes: alteredInstaller });
  assert.equal(installerResult.kind, "failed");
  assert.equal(installerResult.code, "installer-hash-mismatch");

  const alteredManifest = { ...manifest, size: manifest.size + 1 };
  const manifestResult = await runCheck({ manifest: alteredManifest });
  assert.equal(manifestResult.kind, "failed");
  assert.equal(manifestResult.code, "invalid-signature");

  const renamedResult = await runCheck({
    advertisedAssets: [
      "update-manifest.json",
      "update-manifest.sha256",
      "update-manifest.sig",
      "youtubetv-for-windows-2.0.0-renamed.exe",
    ],
  });
  assert.equal(renamedResult.kind, "failed");
  assert.equal(renamedResult.code, "installer-asset-mismatch");
});
