import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ASSET_REDIRECTS,
  validateInitialTarget,
  validateRedirectTarget,
} from "../../src/main/update/redirect-policy.ts";

const API_URL = "https://api.github.com/repos/x/y/releases/assets/1";
const CDN_URL = "https://objects.githubusercontent.com/asset/1";

test("accepts an HTTPS api.github.com initial target", () => {
  const verdict = validateInitialTarget(API_URL);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url.href, API_URL);
});

test("rejects an initial target on another host", () => {
  const verdict = validateInitialTarget("https://evil.example/manifest.json");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "unsupported-initial-host");
});

test("rejects a lookalike initial host", () => {
  for (const url of [
    "https://api.github.com.evil.example/x",
    "https://api.github.com:8443/x",
    "https://user@api.github.com/x",
  ]) {
    const verdict = validateInitialTarget(url);
    assert.equal(verdict.ok, false, `accepted ${url}`);
    assert.equal(verdict.code, "unsupported-initial-host");
  }
});

test("rejects an insecure initial target", () => {
  const verdict = validateInitialTarget("http://api.github.com/x");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "insecure-initial-url");
});

test("rejects a malformed initial URL", () => {
  const verdict = validateInitialTarget("not a url");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "unsupported-initial-host");
});

function redirect(location, followedCount = 0, visited = []) {
  return validateRedirectTarget(
    new URL(API_URL),
    location,
    followedCount,
    new Set(visited),
  );
}

test("accepts a redirect to each documented asset host", () => {
  for (const host of [
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
  ]) {
    const verdict = redirect(`https://${host}/asset`);
    assert.equal(verdict.ok, true, `rejected ${host}`);
  }
});

test("resolves a relative redirect before applying the host policy", () => {
  // A relative Location resolves against api.github.com, which is not an
  // allowed redirect host, so it must be rejected after resolution.
  const verdict = redirect("/asset/next");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "disallowed-redirect-host");
  assert.match(verdict.message, /api\.github\.com/);
});

test("rejects a redirect to a disallowed host", () => {
  const verdict = redirect("https://evil.example/asset");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "disallowed-redirect-host");
});

test("rejects a redirect that downgrades to http", () => {
  const verdict = redirect("http://objects.githubusercontent.com/asset");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "insecure-redirect");
});

test("rejects a fourth redirect", () => {
  const verdict = redirect(CDN_URL, MAX_ASSET_REDIRECTS);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "redirect-limit-exceeded");
});

test("rejects a redirect loop", () => {
  const verdict = redirect(CDN_URL, 1, [CDN_URL]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "redirect-loop");
});

test("rejects credentials inside a redirect target", () => {
  const verdict = redirect("https://user:pass@objects.githubusercontent.com/x");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "disallowed-redirect-host");
});

test("rejects a malformed redirect target", () => {
  const verdict = validateRedirectTarget(
    new URL(API_URL),
    "https://[invalid",
    0,
    new Set(),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "malformed-redirect");
});
