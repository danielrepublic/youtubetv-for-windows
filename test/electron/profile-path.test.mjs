// Spawned Electron suite for the persistent-profile policy.
//
// The fixture host activates the production profile path (real
// app.setPath("sessionData")) before opening the persistent session, then
// sets or reads a cookie. Spawning twice against the SAME base directory
// proves the profile survives a relaunch; a spawn against a file path
// proves the safe-new fallback with bilingual guidance. Every run uses a
// fresh unique base directory and cleans it afterwards.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanRun,
  recordOf,
  spawnFixtureHost,
  startFixtureServer,
} from "./fixture-harness.mjs";

let profileCounter = 0;

function freshBase(t) {
  profileCounter += 1;
  const base = path.join(
    os.tmpdir(),
    `ytv-profile-${process.pid}-${Date.now()}-${profileCounter}`,
  );
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    // The fallback (if any) lives under the OS temp dir with a nonce; the
    // fixture reports its exact path and the fallback test removes it.
    const fallback = t.fallbackDirectory;
    if (typeof fallback === "string") {
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });
  return base;
}

function profileArgs(base, mode, cookieUrl) {
  return [
    "--scenario=profile",
    `--profile-base=${base}`,
    `--mode=${mode}`,
    `--cookie-url=${cookieUrl}`,
    "--cookie-name=ytv_persist_probe",
    "--cookie-value=persist-across-relaunch",
  ];
}

const EXPECTED_DIRECTORY_SUFFIX = path.join("youtubetv-for-windows", "profile");

test("a cookie set in run 1 is present in run 2 against the same profile dir", async (t) => {
  const fixture = await startFixtureServer(t);
  const base = freshBase(t);
  const first = await spawnFixtureHost(profileArgs(base, "set", fixture.url));
  assertCleanRun(first);
  const firstActivation = recordOf(first.records, "profile-activation");
  assert.equal(firstActivation.usedFallback, false);
  assert.ok(
    firstActivation.directory.endsWith(EXPECTED_DIRECTORY_SUFFIX),
    `unexpected profile dir ${firstActivation.directory}`,
  );
  assert.ok(
    !firstActivation.directory.includes("install"),
    "the profile must live outside any install directory",
  );
  assert.ok(
    !/\d+\.\d+\.\d+/.test(firstActivation.directory),
    "no version segment in the profile path",
  );
  recordOf(first.records, "cookie-written");
  const second = await spawnFixtureHost(profileArgs(base, "get", fixture.url));
  assertCleanRun(second);
  const secondActivation = recordOf(second.records, "profile-activation");
  assert.equal(secondActivation.directory, firstActivation.directory);
  assert.equal(secondActivation.usedFallback, false);
  const read = recordOf(second.records, "cookie-read");
  assert.equal(read.value, "persist-across-relaunch");
});

test("a corrupt base falls back to a safe new profile with guidance", async (t) => {
  const fixture = await startFixtureServer(t);
  const base = freshBase(t);
  // A regular file where the profile base directory belongs: creation of
  // the profile directory underneath it must fail.
  fs.writeFileSync(base, "not a directory", "utf8");
  const run = await spawnFixtureHost(profileArgs(base, "get", fixture.url));
  assertCleanRun(run);
  const activation = recordOf(run.records, "profile-activation");
  assert.equal(activation.usedFallback, true);
  assert.ok(
    !activation.directory.startsWith(base),
    "the fallback must not live under the corrupt base",
  );
  assert.ok(activation.guidance !== null, "fallback guidance must be surfaced");
  assert.match(activation.guidance.zhTW, /暫時設定檔/);
  assert.match(activation.guidance.en, /temporary profile/);
  t.fallbackDirectory = activation.directory;
});
