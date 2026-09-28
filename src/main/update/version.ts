/**
 * Self-contained semantic-version parsing and comparison.
 *
 * Deliberately dependency-free and fail-closed: an input that does not match
 * the grammar exactly parses to `undefined`, and every caller treats
 * `undefined` as a rejection. Numeric components are bounded by
 * `Number.isSafeInteger` so an over-long version string cannot lose precision
 * and compare as equal to a different version.
 *
 * Build metadata (`+build`) is accepted but ignored for precedence, exactly as
 * SemVer 2.0.0 specifies.
 */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  readonly prerelease: readonly string[];
}

/**
 * SemVer 2.0.0 grammar:
 *   major.minor.patch where each is `0` or a non-zero-leading integer,
 *   optional `-prerelease` of dot-separated identifiers (no leading zeros in
 *   purely numeric identifiers), optional `+build` of dot-separated
 *   alphanumerics.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const MAX_VERSION_LENGTH = 256;

/** Parses a strict SemVer string, or returns `undefined` (fail closed). */
export function parseSemver(value: string): Semver | undefined {
  if (value.length === 0 || value.length > MAX_VERSION_LENGTH) {
    return undefined;
  }
  const match = SEMVER_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }
  const prereleaseText = match[4];
  const prerelease =
    prereleaseText === undefined ? [] : prereleaseText.split(".");
  return { major, minor, patch, prerelease };
}

/** True when the parsed version has no prerelease identifiers. */
export function isStableVersion(version: Semver): boolean {
  return version.prerelease.length === 0;
}

function compareNumeric(a: number, b: number): -1 | 0 | 1 {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value);
}

function comparePrerelease(
  a: readonly string[],
  b: readonly string[],
): -1 | 0 | 1 {
  // A version without prerelease identifiers has higher precedence.
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) {
      // Shared prefix, left is shorter: lower precedence.
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    const leftNumeric = isNumericIdentifier(left);
    const rightNumeric = isNumericIdentifier(right);
    if (leftNumeric && rightNumeric) {
      const numeric = compareNumeric(Number(left), Number(right));
      if (numeric !== 0) {
        return numeric;
      }
      continue;
    }
    if (leftNumeric) {
      return -1;
    }
    if (rightNumeric) {
      return 1;
    }
    if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** Three-way SemVer precedence comparison; build metadata is ignored. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  const major = compareNumeric(a.major, b.major);
  if (major !== 0) {
    return major;
  }
  const minor = compareNumeric(a.minor, b.minor);
  if (minor !== 0) {
    return minor;
  }
  const patch = compareNumeric(a.patch, b.patch);
  if (patch !== 0) {
    return patch;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}
