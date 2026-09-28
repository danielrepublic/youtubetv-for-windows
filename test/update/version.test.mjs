import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSemver,
  isStableVersion,
  parseSemver,
} from "../../src/main/update/version.ts";

function compare(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  assert.notEqual(a, undefined, `failed to parse ${left}`);
  assert.notEqual(b, undefined, `failed to parse ${right}`);
  return compareSemver(a, b);
}

test("parses a plain release version", () => {
  assert.deepEqual(parseSemver("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
  });
});

test("parses prerelease and ignores build metadata", () => {
  assert.deepEqual(parseSemver("1.2.3-beta.2+build.5")?.prerelease, [
    "beta",
    "2",
  ]);
});

test("rejects malformed version strings", () => {
  for (const value of [
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "v1.2.3",
    "1.2.3-",
    "1.2.3-beta..1",
    "1.2.3 beta",
    "latest",
  ]) {
    assert.equal(parseSemver(value), undefined, `accepted ${value}`);
  }
});

test("rejects numbers that exceed safe integer precision", () => {
  assert.equal(parseSemver("99999999999999999999.0.0"), undefined);
});

test("compares major, minor, and patch numerically", () => {
  assert.equal(compare("1.0.0", "1.0.1"), -1);
  assert.equal(compare("1.0.1", "1.0.0"), 1);
  assert.equal(compare("2.0.0", "1.9.9"), 1);
  assert.equal(compare("1.10.0", "1.9.0"), 1);
  assert.equal(compare("1.0.0", "1.0.0"), 0);
});

test("orders prereleases by the SemVer precedence rules", () => {
  assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
  assert.equal(compare("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compare("1.0.0-alpha.beta", "1.0.0-beta"), -1);
  assert.equal(compare("1.0.0-beta", "1.0.0-beta.2"), -1);
  assert.equal(compare("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compare("1.0.0-rc.1", "1.0.0"), -1);
});

test("build metadata does not affect precedence", () => {
  assert.equal(compare("1.0.0+build.1", "1.0.0+build.2"), 0);
});

test("detects stable versus prerelease versions", () => {
  assert.equal(isStableVersion(parseSemver("1.0.0")), true);
  assert.equal(isStableVersion(parseSemver("1.0.0-rc.1")), false);
});
