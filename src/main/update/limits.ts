/**
 * Bounded budgets for a single update check.
 *
 * Every network read is bounded by a timeout, every body by a byte budget, and
 * the redirect chain by an explicit count. Tests inject tiny values so the
 * adversarial corpus can exercise the timeout and size limits without any
 * real network or clock manipulation.
 */
export interface UpdateLimits {
  /** Per-request AbortController timeout in milliseconds. */
  readonly requestTimeoutMs: number;
  /** Maximum accepted byte size for the release body and manifest/signature. */
  readonly maxManifestBytes: number;
  /** Maximum accepted byte size for the installer download. */
  readonly maxInstallerBytes: number;
  /** Maximum number of 302 hops followed after the initial request. */
  readonly maxRedirects: number;
  /** Additional attempts after the first for transient transport failures. */
  readonly retries: number;
  /** Delay between retry attempts, in milliseconds. */
  readonly retryDelayMs: number;
  /** Age after which an existing update lock is considered abandoned. */
  readonly lockStaleMs: number;
}

/** Conservative production defaults; override per call in tests. */
export const DEFAULT_UPDATE_LIMITS: UpdateLimits = Object.freeze({
  requestTimeoutMs: 10_000,
  maxManifestBytes: 256 * 1024,
  maxInstallerBytes: 512 * 1024 * 1024,
  maxRedirects: 3,
  retries: 2,
  retryDelayMs: 250,
  lockStaleMs: 10 * 60 * 1000,
});

/** Merges a partial override over the production defaults. */
export function resolveUpdateLimits(
  overrides?: Partial<UpdateLimits>,
): UpdateLimits {
  if (overrides === undefined) {
    return DEFAULT_UPDATE_LIMITS;
  }
  return Object.freeze({ ...DEFAULT_UPDATE_LIMITS, ...overrides });
}
