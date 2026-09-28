import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJsonText } from "../../src/main/update/canonical.ts";
import {
  KEYRING_PLACEHOLDER,
  PRODUCTION_KEYRING,
  resolveVerificationKey,
} from "../../src/main/update/keyring.ts";
import { toSignableJson } from "../../src/main/update/manifest-schema.ts";
import { verifyManifestSignature } from "../../src/main/update/signature.ts";
import {
  createManifest,
  createTestKeypair,
  prettyManifestText,
} from "./fixture-helpers.mjs";

function verify(manifest, signatureBase64, keyring) {
  return verifyManifestSignature({ keyring, manifest, signatureBase64 });
}

test("verifies a signature computed over the canonical manifest bytes", () => {
  const keyPair = createTestKeypair();
  const manifest = createManifest({ keyId: keyPair.keyId });
  const signature = keyPair.signBytes(
    Buffer.from(canonicalJsonText(toSignableJson(manifest)), "utf8"),
  );
  const result = verify(manifest, signature, keyPair.keyring);
  assert.deepEqual(result, { ok: true });
});

test("rejects a bit-flipped signature", () => {
  const keyPair = createTestKeypair();
  const manifest = createManifest({ keyId: keyPair.keyId });
  const signature = keyPair.signBytes(
    Buffer.from(canonicalJsonText(toSignableJson(manifest)), "utf8"),
  );
  const raw = Buffer.from(signature, "base64");
  raw[0] ^= 0x01;
  const result = verify(manifest, raw.toString("base64"), keyPair.keyring);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-signature");
});

test("rejects a signature computed over the received file bytes instead of canonical bytes", () => {
  const keyPair = createTestKeypair();
  const manifest = createManifest({ keyId: keyPair.keyId });
  // Sign the pretty-printed, reordered wire format. The signer and verifier
  // disagree about the payload, so verification must fail.
  const signature = keyPair.signBytes(
    Buffer.from(prettyManifestText(manifest), "utf8"),
  );
  const result = verify(manifest, signature, keyPair.keyring);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-signature");
});

test("rejects an unknown key id before trusting any field", () => {
  const keyPair = createTestKeypair("test-key-a");
  const manifest = createManifest({ keyId: "test-key-missing" });
  const signature = keyPair.signBytes(
    Buffer.from(canonicalJsonText(toSignableJson(manifest)), "utf8"),
  );
  const result = verify(manifest, signature, keyPair.keyring);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown-key-id");
});

test("accepts a signature made by a next-rotation key", () => {
  const keyPair = createTestKeypair("rotation-next");
  const manifest = createManifest({ keyId: "rotation-next" });
  const keyring = {
    keys: [{ ...keyPair.keyring.keys[0], status: "next" }],
  };
  const signature = keyPair.signBytes(
    Buffer.from(canonicalJsonText(toSignableJson(manifest)), "utf8"),
  );
  assert.deepEqual(verify(manifest, signature, keyring), { ok: true });
});

test("rejects a signature that is not 64 base64 bytes", () => {
  const keyPair = createTestKeypair();
  const manifest = createManifest({ keyId: keyPair.keyId });
  const result = verify(manifest, "not base64 !!", keyPair.keyring);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-signature");
});

test("fails closed on placeholder key material", () => {
  const keyPair = createTestKeypair("ytvw-release-primary");
  const manifest = createManifest({ keyId: "ytvw-release-primary" });
  const signature = keyPair.signBytes(
    Buffer.from(canonicalJsonText(toSignableJson(manifest)), "utf8"),
  );
  const result = verify(manifest, signature, PRODUCTION_KEYRING);
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-key-material");
});

test("the production keyring ships only placeholders and public keys", () => {
  assert.ok(PRODUCTION_KEYRING.keys.length >= 2);
  const statuses = PRODUCTION_KEYRING.keys.map((key) => key.status).sort();
  assert.deepEqual(statuses, ["active", "next"]);
  for (const key of PRODUCTION_KEYRING.keys) {
    assert.equal(key.spkiBase64, KEYRING_PLACEHOLDER);
    assert.ok(!/PRIVATE|BEGIN .*KEY/.test(key.spkiBase64));
    assert.ok(!key.spkiBase64.includes("-----"));
  }
  assert.equal(
    resolveVerificationKey(PRODUCTION_KEYRING, "does-not-exist"),
    undefined,
  );
  assert.equal(
    resolveVerificationKey(PRODUCTION_KEYRING, "ytvw-release-primary")?.status,
    "active",
  );
});
