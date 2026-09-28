/**
 * Download the selected installer and verify its integrity byte-for-byte.
 *
 * The signed manifest supplies the only accepted byte size and SHA-256, so
 * the download is streamed into the pending directory while hashing, and it
 * is rejected the moment it grows past the signed size. Checks are ordered
 * cheapest-and-most-specific first:
 *
 *   1. `download-truncated`  — declared length or the stream ended early.
 *   2. `installer-empty`     — zero bytes were received.
 *   3. `installer-size-mismatch` — byte count differs from the manifest.
 *   4. `installer-hash-mismatch` — SHA-256 differs from the manifest.
 *
 * Every failure removes the partially written file. The caller still owns
 * removing the enclosing nonce directory.
 */
import { createHash } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import { openDownloadStream, type Transport } from "./http-download.ts";
import type { UpdateLimits } from "./limits.ts";
import { installerPathFor } from "./pending.ts";

export interface VerifiedInstaller {
  /** Verified local path inside the private pending directory. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export type InstallerDownload =
  | { readonly ok: true; readonly installer: VerifiedInstaller }
  | {
      readonly ok: false;
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

export interface DownloadVerifiedInstallerOptions {
  readonly transport: Transport;
  /** Asset API URL from the release body. */
  readonly assetUrl: string;
  /** Exact asset name; also the file name inside the pending directory. */
  readonly assetName: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  /** Nonce directory created for this attempt. */
  readonly directory: string;
  readonly limits: UpdateLimits;
}

class StorageWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageWriteError";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // best effort
  }
}

async function unlinkQuietly(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
  } catch {
    // best effort
  }
}

async function writeFully(
  handle: FileHandle,
  buffer: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    if (result.bytesWritten <= 0) {
      throw new StorageWriteError(
        "the installer file accepted zero bytes on write",
      );
    }
    offset += result.bytesWritten;
  }
}

/**
 * Streams the installer into `directory`, verifying declared length, the
 * signed byte size, and the signed SHA-256. Resolves a classified result;
 * never throws.
 */
export async function downloadVerifiedInstaller(
  options: DownloadVerifiedInstallerOptions,
): Promise<InstallerDownload> {
  if (options.expectedSize > options.limits.maxInstallerBytes) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.DOWNLOAD_TOO_LARGE,
      message: `the signed installer size ${options.expectedSize} exceeds the ${options.limits.maxInstallerBytes} byte budget`,
    };
  }

  const outcome = await openDownloadStream(
    options.transport,
    options.assetUrl,
    {
      headers: { accept: "application/octet-stream" },
      maxBytes: options.limits.maxInstallerBytes,
      limits: options.limits,
    },
  );
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  const targetPath = installerPathFor(options.directory, options.assetName);
  let handle: FileHandle;
  try {
    handle = await open(targetPath, "wx", 0o600);
  } catch (error) {
    return {
      ok: false,
      code: UPDATE_ERROR_CODES.STORAGE_ERROR,
      message: `could not create the pending installer file: ${describe(error)}`,
    };
  }

  const declaredText = outcome.response.headers.get("content-length");
  const declared = declaredText === null ? undefined : Number(declaredText);
  const hash = createHash("sha256");
  let total = 0;
  let failure: { code: UpdateErrorCode; message: string } | undefined;

  const body = outcome.response.body;
  if (body !== null) {
    try {
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        if (total + buffer.length > options.limits.maxInstallerBytes) {
          failure = {
            code: UPDATE_ERROR_CODES.DOWNLOAD_TOO_LARGE,
            message: `the installer exceeded the ${options.limits.maxInstallerBytes} byte budget`,
          };
          break;
        }
        if (total + buffer.length > options.expectedSize) {
          failure = {
            code: UPDATE_ERROR_CODES.INSTALLER_SIZE_MISMATCH,
            message: `the installer grew past the signed size of ${options.expectedSize} bytes`,
          };
          break;
        }
        await writeFully(handle, buffer);
        hash.update(buffer);
        total += buffer.length;
      }
    } catch (error) {
      failure =
        error instanceof StorageWriteError
          ? {
              code: UPDATE_ERROR_CODES.STORAGE_ERROR,
              message: `could not write the pending installer: ${describe(error)}`,
            }
          : {
              code: UPDATE_ERROR_CODES.DOWNLOAD_TRUNCATED,
              message: `the installer download ended early: ${describe(error)}`,
            };
    }
  }

  if (
    failure === undefined &&
    declared !== undefined &&
    Number.isFinite(declared) &&
    declared !== total
  ) {
    failure = {
      code: UPDATE_ERROR_CODES.DOWNLOAD_TRUNCATED,
      message: `the installer body is ${total} bytes but ${declared} were declared`,
    };
  }
  if (failure === undefined && total === 0) {
    failure = {
      code: UPDATE_ERROR_CODES.INSTALLER_EMPTY,
      message: "the downloaded installer was zero bytes",
    };
  }
  if (failure === undefined && total !== options.expectedSize) {
    failure = {
      code: UPDATE_ERROR_CODES.INSTALLER_SIZE_MISMATCH,
      message: `the installer is ${total} bytes but the manifest declares ${options.expectedSize}`,
    };
  }
  const actualSha256 = hash.digest("hex");
  if (failure === undefined && actualSha256 !== options.expectedSha256) {
    failure = {
      code: UPDATE_ERROR_CODES.INSTALLER_HASH_MISMATCH,
      message: "the installer SHA-256 does not match the signed manifest",
    };
  }

  if (failure !== undefined) {
    await closeQuietly(handle);
    await unlinkQuietly(targetPath);
    return { ok: false, code: failure.code, message: failure.message };
  }

  await handle.close();
  return {
    ok: true,
    installer: {
      path: targetPath,
      size: total,
      sha256: actualSha256,
    },
  };
}
