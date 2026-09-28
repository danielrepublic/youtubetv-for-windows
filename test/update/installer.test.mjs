import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { downloadVerifiedInstaller } from "../../src/main/update/installer.ts";
import {
  createPendingDirectory,
  installerPathFor,
} from "../../src/main/update/pending.ts";
import {
  DEFAULT_INSTALLER_BYTES as INSTALLER_BYTES,
  INSTALLER_ASSET_NAME,
  INSTALLER_ASSET_URL,
  INSTALLER_REDIRECT_URL,
  TEST_LIMITS,
  bytesResponse,
  createTempBaseDirectory,
  createTransport,
  redirectResponse,
  sha256Hex,
} from "./fixture-helpers.mjs";

function installerTransport(responder) {
  return createTransport((url) => {
    if (url === INSTALLER_ASSET_URL) {
      return redirectResponse(INSTALLER_REDIRECT_URL);
    }
    if (url === INSTALLER_REDIRECT_URL) {
      return responder();
    }
    throw new Error(`unexpected request URL: ${url}`);
  });
}

/**
 * Runs one installer download in a throwaway base directory and always
 * removes the directory afterwards, even when an assertion fails.
 */
async function withCase(options, assertions) {
  const temp = createTempBaseDirectory();
  try {
    const pending = createPendingDirectory(temp.baseDirectory);
    assert.equal(pending.ok, true);
    if (options.prepare !== undefined) {
      options.prepare(pending.directory);
    }
    const recording = installerTransport(options.responder);
    const result = await downloadVerifiedInstaller({
      transport: recording.transport,
      assetUrl: INSTALLER_ASSET_URL,
      assetName: INSTALLER_ASSET_NAME,
      expectedSize: options.expectedSize,
      expectedSha256: options.expectedSha256,
      directory: pending.directory,
      limits: options.limits ?? TEST_LIMITS,
    });
    await assertions({
      result,
      recording,
      pending,
      targetPath: installerPathFor(pending.directory, INSTALLER_ASSET_NAME),
    });
  } finally {
    temp.cleanup();
  }
}

test("downloads, hashes, and writes the exact installer bytes", async () => {
  await withCase(
    {
      responder: () => bytesResponse(INSTALLER_BYTES),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, recording, targetPath }) => {
      assert.equal(result.ok, true);
      assert.equal(result.installer.path, targetPath);
      assert.equal(result.installer.size, INSTALLER_BYTES.length);
      assert.equal(result.installer.sha256, sha256Hex(INSTALLER_BYTES));
      assert.deepEqual(fs.readFileSync(targetPath), INSTALLER_BYTES);
      assert.deepEqual(
        recording.calls.map((call) => call.url),
        [INSTALLER_ASSET_URL, INSTALLER_REDIRECT_URL],
      );
      assert.equal(
        recording.calls[0].headers.accept,
        "application/octet-stream",
      );
    },
  );
});

test("rejects a zero-byte installer and removes the partial file", async () => {
  await withCase(
    {
      responder: () =>
        bytesResponse(Buffer.alloc(0), {
          headers: { "content-length": "0" },
        }),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "installer-empty");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("rejects a truncated mid-stream download and removes the partial file", async () => {
  let pulls = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(INSTALLER_BYTES.subarray(0, 512));
      } else {
        controller.error(new Error("connection reset"));
      }
    },
  });
  await withCase(
    {
      responder: () =>
        new Response(stream, {
          headers: { "content-length": String(INSTALLER_BYTES.length) },
        }),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "download-truncated");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("rejects a body shorter than its declared content length", async () => {
  await withCase(
    {
      responder: () =>
        bytesResponse(INSTALLER_BYTES.subarray(0, 100), {
          headers: { "content-length": String(INSTALLER_BYTES.length) },
        }),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "download-truncated");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("rejects an installer that grows past the signed size", async () => {
  const extra = Buffer.concat([INSTALLER_BYTES, Buffer.from([0x2a])]);
  await withCase(
    {
      responder: () => bytesResponse(extra),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "installer-size-mismatch");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("rejects an installer shorter than the signed size", async () => {
  await withCase(
    {
      responder: () => bytesResponse(INSTALLER_BYTES.subarray(0, 100)),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "installer-size-mismatch");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("rejects a valid-size installer with the wrong SHA-256", async () => {
  await withCase(
    {
      responder: () => bytesResponse(INSTALLER_BYTES),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(Buffer.from("different bytes")),
    },
    async ({ result, targetPath }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "installer-hash-mismatch");
      assert.equal(fs.existsSync(targetPath), false);
    },
  );
});

test("refuses to reuse a pre-existing pending file", async () => {
  await withCase(
    {
      prepare(directory) {
        fs.writeFileSync(path.join(directory, INSTALLER_ASSET_NAME), "planted");
      },
      responder: () => bytesResponse(INSTALLER_BYTES),
      expectedSize: INSTALLER_BYTES.length,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
    },
    async ({ result }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "storage-error");
    },
  );
});

test("rejects a signed size above the installer byte budget before requesting", async () => {
  await withCase(
    {
      responder: () => {
        throw new Error("transport must not be called");
      },
      expectedSize: 4096,
      expectedSha256: sha256Hex(INSTALLER_BYTES),
      limits: { ...TEST_LIMITS, maxInstallerBytes: 1024 },
    },
    async ({ result, recording }) => {
      assert.equal(result.ok, false);
      assert.equal(result.code, "download-too-large");
      assert.equal(recording.calls.length, 0);
    },
  );
});
