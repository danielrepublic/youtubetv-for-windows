import assert from "node:assert/strict";
import test from "node:test";
import {
  parseUpdateManifest,
  toSignableJson,
} from "../../src/main/update/manifest-schema.ts";
import {
  DEFAULT_INSTALLER_BYTES,
  createManifest,
  prettyManifestText,
} from "./fixture-helpers.mjs";

function parse(manifest) {
  return parseUpdateManifest(JSON.stringify(manifest));
}

test("accepts a complete valid manifest and round-trips every field", () => {
  const manifest = createManifest();
  const result = parse(manifest);
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest, manifest);
});

test("rejects a missing required key", () => {
  const manifest = createManifest();
  delete manifest.keyId;
  const result = parse(manifest);
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing-manifest-key");
});

test("rejects an unknown top-level key", () => {
  const result = parse(createManifest({ extra: "surprise" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-manifest-key");
});

test("rejects a non-object manifest", () => {
  const result = parseUpdateManifest("[1,2,3]");
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-manifest-field");
});

test("rejects a non-numeric schemaVersion", () => {
  const result = parse(createManifest({ schemaVersion: "1" }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-manifest-field");
});

test("rejects an uppercase or short sha256", () => {
  const uppercase = parse(createManifest({ sha256: "A".repeat(64) }));
  assert.equal(uppercase.ok, false);
  assert.equal(uppercase.code, "invalid-sha256");
  const short = parse(createManifest({ sha256: "abc123" }));
  assert.equal(short.ok, false);
  assert.equal(short.code, "invalid-sha256");
});

test("rejects a non-string sha256", () => {
  const result = parse(createManifest({ sha256: 1234 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-manifest-field");
});

test("rejects zero, negative, and fractional sizes", () => {
  for (const size of [0, -1, 1.5]) {
    const result = parse(createManifest({ size }));
    assert.equal(result.ok, false, `accepted size ${size}`);
    assert.equal(result.code, "invalid-manifest-field");
  }
});

test("rejects installer asset names that escape the pending directory", () => {
  for (const installerAssetName of [
    "../evil.exe",
    "sub/dir/evil.exe",
    "sub\\dir\\evil.exe",
    "..",
    ".",
    "",
  ]) {
    const result = parse(createManifest({ installerAssetName }));
    assert.equal(result.ok, false, `accepted ${installerAssetName}`);
    assert.equal(result.code, "invalid-manifest-field");
  }
});

test("rejects non-semver version fields with a distinct code", () => {
  const version = parse(createManifest({ version: "2.0" }));
  assert.equal(version.ok, false);
  assert.equal(version.code, "invalid-semver");
  const minApp = parse(createManifest({ minAppVersion: "next" }));
  assert.equal(minApp.ok, false);
  assert.equal(minApp.code, "invalid-semver");
  const minBootstrap = parse(
    createManifest({ minBootstrapVersion: "1.0.0.0" }),
  );
  assert.equal(minBootstrap.ok, false);
  assert.equal(minBootstrap.code, "invalid-semver");
});

test("rejects malformed JSON before looking at any field", () => {
  const result = parseUpdateManifest("{not json");
  assert.equal(result.ok, false);
  assert.equal(result.code, "malformed-manifest-json");
});

test("rejects a duplicated key even when both values are valid", () => {
  const manifest = createManifest();
  const text = prettyManifestText(manifest).replace(
    '"channel": "stable"',
    '"channel": "stable",\n  "channel": "stable"',
  );
  assert.notEqual(
    text,
    prettyManifestText(manifest),
    "fixture must contain a duplicate",
  );
  const result = parseUpdateManifest(text);
  assert.equal(result.ok, false);
  assert.equal(result.code, "duplicate-json-key");
});

test("toSignableJson emits exactly the ten signed fields", () => {
  const manifest = createManifest();
  const signable = toSignableJson(manifest);
  assert.deepEqual(Object.keys(signable).sort(), [
    "channel",
    "installerAssetName",
    "keyId",
    "minAppVersion",
    "minBootstrapVersion",
    "releaseTag",
    "schemaVersion",
    "sha256",
    "size",
    "version",
  ]);
});

test("a valid manifest with the default installer bytes hashes to its declared sha256", () => {
  const manifest = createManifest({ installerBytes: DEFAULT_INSTALLER_BYTES });
  const result = parse(manifest);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.size, DEFAULT_INSTALLER_BYTES.length);
});
