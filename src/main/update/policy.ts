/**
 * Version and binding rules applied AFTER the signature verifies.
 *
 * Everything here answers "may this signed manifest be applied to THIS
 * installation, coming from THIS API release?":
 *
 *   - schema version must be supported,
 *   - channel must be the stable channel,
 *   - the version must be a stable semver newer than the installed app
 *     (equal means up-to-date; older rejects as `downgrade`, which is also
 *     how a replay of an older validly signed manifest is rejected),
 *   - `releaseTag` must equal the API release `tag_name`,
 *   - `installerAssetName` must be one of the release's exact asset names,
 *   - `minBootstrapVersion` / `minAppVersion` must not exceed the injected
 *     running bootstrap/app versions.
 */
import { UPDATE_ERROR_CODES, type UpdateErrorCode } from "./error-codes.ts";
import type { GitHubRelease } from "./discovery.ts";
import {
  SUPPORTED_SCHEMA_VERSION,
  type UpdateManifest,
} from "./manifest-schema.ts";
import {
  compareSemver,
  isStableVersion,
  parseSemver,
  type Semver,
} from "./version.ts";

/** The only channel this launcher follows. */
export const ALLOWED_UPDATE_CHANNEL = "stable";

export type PolicyEvaluation =
  | {
      readonly ok: true;
      readonly manifest: UpdateManifest;
      readonly installerAssetUrl: string;
    }
  | { readonly ok: false; readonly kind: "up-to-date" }
  | {
      readonly ok: false;
      readonly kind: "rejected";
      readonly code: UpdateErrorCode;
      readonly message: string;
    };

export interface EvaluateUpdatePolicyOptions {
  readonly manifest: UpdateManifest;
  readonly release: GitHubRelease;
  /** Version of the installed application (freshness comparison). */
  readonly currentVersion: string;
  /** Version of the running app for the `minAppVersion` gate. */
  readonly appVersion: string;
  /** Version of the running bootstrap for the `minBootstrapVersion` gate. */
  readonly bootstrapVersion: string;
}

function rejected(code: UpdateErrorCode, message: string): PolicyEvaluation {
  return { ok: false, kind: "rejected", code, message };
}

function parseOrReject(
  value: string,
  label: string,
): Semver | PolicyEvaluation {
  const parsed = parseSemver(value);
  if (parsed === undefined) {
    return rejected(
      UPDATE_ERROR_CODES.INVALID_SEMVER,
      `${label} is not a semantic version: ${value}`,
    );
  }
  return parsed;
}

function isPolicyEvaluation(
  value: Semver | PolicyEvaluation,
): value is PolicyEvaluation {
  return "ok" in value;
}

/** Evaluates every non-signature rule for one signed manifest. */
export function evaluateUpdatePolicy(
  options: EvaluateUpdatePolicyOptions,
): PolicyEvaluation {
  const { manifest, release } = options;

  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return rejected(
      UPDATE_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
      `manifest schema version ${manifest.schemaVersion} is not supported (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  }
  if (manifest.channel !== ALLOWED_UPDATE_CHANNEL) {
    return rejected(
      UPDATE_ERROR_CODES.CHANNEL_NOT_ALLOWED,
      `manifest channel is not the stable channel: ${manifest.channel}`,
    );
  }

  const manifestVersion = parseOrReject(manifest.version, "manifest version");
  if (isPolicyEvaluation(manifestVersion)) {
    return manifestVersion;
  }
  if (!isStableVersion(manifestVersion)) {
    return rejected(
      UPDATE_ERROR_CODES.PRERELEASE_VERSION_UNSUPPORTED,
      `manifest version is a prerelease: ${manifest.version}`,
    );
  }

  const currentVersion = parseOrReject(
    options.currentVersion,
    "installed version",
  );
  if (isPolicyEvaluation(currentVersion)) {
    return currentVersion;
  }
  const freshness = compareSemver(manifestVersion, currentVersion);
  if (freshness === 0) {
    return { ok: false, kind: "up-to-date" };
  }
  if (freshness < 0) {
    return rejected(
      UPDATE_ERROR_CODES.DOWNGRADE,
      `manifest version ${manifest.version} is not newer than the installed ${options.currentVersion}`,
    );
  }

  if (manifest.releaseTag !== release.tagName) {
    return rejected(
      UPDATE_ERROR_CODES.RELEASE_TAG_MISMATCH,
      `manifest releaseTag ${manifest.releaseTag} does not match the API release tag ${release.tagName}`,
    );
  }

  const installerAsset = release.assets.find(
    (asset) => asset.name === manifest.installerAssetName,
  );
  if (installerAsset === undefined) {
    return rejected(
      UPDATE_ERROR_CODES.INSTALLER_ASSET_MISMATCH,
      `manifest installerAssetName ${manifest.installerAssetName} is not a release asset`,
    );
  }

  const minBootstrap = parseOrReject(
    manifest.minBootstrapVersion,
    "minBootstrapVersion",
  );
  if (isPolicyEvaluation(minBootstrap)) {
    return minBootstrap;
  }
  const bootstrap = parseOrReject(
    options.bootstrapVersion,
    "running bootstrap version",
  );
  if (isPolicyEvaluation(bootstrap)) {
    return bootstrap;
  }
  if (compareSemver(minBootstrap, bootstrap) > 0) {
    return rejected(
      UPDATE_ERROR_CODES.MIN_BOOTSTRAP_VERSION_UNSUPPORTED,
      `manifest requires bootstrap ${manifest.minBootstrapVersion}, running ${options.bootstrapVersion}`,
    );
  }

  const minApp = parseOrReject(manifest.minAppVersion, "minAppVersion");
  if (isPolicyEvaluation(minApp)) {
    return minApp;
  }
  const app = parseOrReject(options.appVersion, "running app version");
  if (isPolicyEvaluation(app)) {
    return app;
  }
  if (compareSemver(minApp, app) > 0) {
    return rejected(
      UPDATE_ERROR_CODES.MIN_APP_VERSION_UNSUPPORTED,
      `manifest requires app ${manifest.minAppVersion}, running ${options.appVersion}`,
    );
  }

  return {
    ok: true,
    manifest,
    installerAssetUrl: installerAsset.url,
  };
}
