// Least-privilege ACL suite for per-user profile directories (issue #2).
//
// The app hardens its own `users\by-sid\<SID>` directory at runtime: a
// PowerShell guard refuses a reparse point or a directory the account does not
// own, then three ordered icacls calls freeze inheritance, strip the shared
// Users grant, and grant only the owner full control. It fails closed to the
// temp fallback when it cannot. These tests drive hardenProfileDirectory with
// an injected fake runner/filesystem, so no real PowerShell or icacls runs in
// the unit half; the final test is a real-Windows integration that applies the
// installer grant shape to a scratch root, hardens it, and asserts the Users
// ACE is gone from the whole subtree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  HARDEN_ACL_TIMEOUT_MS,
  PROFILE_ACL_MARKER_CONTENT,
  PROFILE_ACL_MARKER_NAME,
  USERS_SID,
  hardenProfileDirectory,
} = await import("../../src/main/profile-acl.ts");
const { SID_PATTERN } = await import("../../src/main/windows-user-identity.ts");

const PROBE_SID = "S-1-5-21-1000-2000-3000-1001";
const PROBE_DIR =
  "C:\\ProgramData\\youtubetv-for-windows\\users\\by-sid\\S-1-5-21-1000-2000-3000-1001";

// A fake PowerShell/icacls runner: records every spawn and either succeeds or
// throws like execFileSync does on a nonzero exit.
function makeRunner({ powershellExit = 0, icaclsExit = 0 } = {}) {
  const calls = [];
  const runner = (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const isPowerShell = file.endsWith("powershell.exe");
    const exit = isPowerShell ? powershellExit : icaclsExit;
    if (exit !== 0) {
      const error = new Error(`fake tool exited ${exit}`);
      error.status = exit;
      throw error;
    }
    return Buffer.from("");
  };
  return { calls, runner };
}

function powershellCalls(calls) {
  return calls.filter((call) => call.file.endsWith("powershell.exe"));
}

function icaclsCalls(calls) {
  return calls.filter((call) => call.file.endsWith("icacls.exe"));
}

function makeFileSystem({ markerExists = true, children = [] } = {}) {
  const written = [];
  return {
    written,
    fileSystem: {
      existsSync: () => markerExists,
      readdirSync: () =>
        children.map((name) => ({ name, isDirectory: () => true })),
      writeFileSync: (candidate, data) => {
        written.push({ candidate, data });
      },
    },
  };
}

function depsWith(overrides = {}) {
  const { calls, runner } = makeRunner(overrides.runner ?? {});
  const { written, fileSystem } = makeFileSystem(overrides);
  return {
    calls,
    written,
    deps: {
      runner,
      fileSystem,
      systemRoot: overrides.systemRoot ?? "C:\\Windows",
    },
  };
}

test("the guard carries the reparse and owner checks, with no shell", () => {
  const { calls, deps } = depsWith();
  assert.deepEqual(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps), {
    ok: true,
  });
  const spawned = powershellCalls(calls);
  assert.equal(spawned.length, 1);
  const [call] = spawned;
  assert.ok(call.file.endsWith("powershell.exe"));
  assert.ok(Array.isArray(call.args));
  assert.deepEqual(call.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  const [script] = call.args.slice(3);
  assert.match(script, /System\.IO\.DirectoryInfo/);
  assert.match(script, /GetAccessControl/);
  assert.match(script, /exit 2/);
  assert.match(script, /exit 3/);
  assert.doesNotMatch(script, /Get-Acl|Set-Acl|SetAccessControl/);
  assert.ok(
    script.includes("S-1-5-32-544"),
    "the owner guard must also accept an Administrators-owned directory",
  );
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, HARDEN_ACL_TIMEOUT_MS);
});

test("hardening freezes inheritance, strips Users, then grants only the owner", () => {
  const { calls, written, deps } = depsWith({ markerExists: true });
  assert.deepEqual(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps), {
    ok: true,
  });
  const steps = icaclsCalls(calls);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0].args, [PROBE_DIR, "/inheritance:d"]);
  assert.deepEqual(steps[1].args, [PROBE_DIR, "/remove:g", `*${USERS_SID}`]);
  assert.deepEqual(steps[2].args, [
    PROBE_DIR,
    "/grant",
    `*${PROBE_SID}:(OI)(CI)F`,
  ]);
  for (const step of steps) {
    assert.ok(step.file.endsWith("icacls.exe"));
    assert.equal(step.options.windowsHide, true);
    assert.equal(step.options.timeout, HARDEN_ACL_TIMEOUT_MS);
  }
  assert.deepEqual(written, []);
});

test("an invalid SID fails without spawning anything", () => {
  assert.ok(!SID_PATTERN.test("S-1-5-32-545'; evil #"));
  const { calls, deps } = depsWith();
  const result = hardenProfileDirectory(
    PROBE_DIR,
    "S-1-5-32-545'; evil #",
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test("a single-quoted directory cannot break out of -LiteralPath", () => {
  const { calls, deps } = depsWith();
  const tricky = "C:\\ProgramData\\ytv'a\\by-sid\\S-1-5-21-1-2-3-4";
  const result = hardenProfileDirectory(tricky, PROBE_SID, deps);
  assert.deepEqual(result, { ok: true });
  const [script] = powershellCalls(calls)[0].args.slice(3);
  assert.ok(
    script.includes("'C:\\ProgramData\\ytv''a\\by-sid\\S-1-5-21-1-2-3-4'"),
    `the directory must be single-quote escaped, got: ${script}`,
  );
});

test("a reparse-point directory fails closed (exit 2)", () => {
  const { calls, deps } = depsWith({ runner: { powershellExit: 2 } });
  assert.equal(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps).ok, false);
  assert.equal(icaclsCalls(calls).length, 0);
});

test("an owner mismatch fails closed (exit 3)", () => {
  const { calls, deps } = depsWith({ runner: { powershellExit: 3 } });
  assert.equal(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps).ok, false);
  assert.equal(icaclsCalls(calls).length, 0);
});

test("any other nonzero PowerShell exit fails closed", () => {
  const { deps } = depsWith({ runner: { powershellExit: 1 } });
  assert.equal(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps).ok, false);
});

test("a failing icacls step fails closed without writing the marker", () => {
  const { written, deps } = depsWith({
    markerExists: false,
    children: ["profile"],
    runner: { icaclsExit: 1 },
  });
  assert.equal(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps).ok, false);
  assert.deepEqual(written, []);
});

test("a present marker skips the descendant reset", () => {
  const { calls, written, deps } = depsWith({ markerExists: true });
  assert.deepEqual(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps), {
    ok: true,
  });
  assert.equal(powershellCalls(calls).length, 1);
  assert.equal(
    icaclsCalls(calls).filter((call) => call.args.includes("/reset")).length,
    0,
  );
  assert.deepEqual(written, []);
});

test("a missing marker resets each child directory, then writes the marker", () => {
  const { calls, written, deps } = depsWith({
    markerExists: false,
    children: ["profile", "userdata"],
  });
  assert.deepEqual(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps), {
    ok: true,
  });
  const resets = icaclsCalls(calls).filter((call) =>
    call.args.includes("/reset"),
  );
  assert.equal(resets.length, 2);
  for (const [index, name] of ["profile", "userdata"].entries()) {
    assert.deepEqual(resets[index].args, [
      path.join(PROBE_DIR, name),
      "/reset",
      "/T",
      "/C",
      "/Q",
    ]);
  }
  assert.deepEqual(written, [
    {
      candidate: path.join(PROBE_DIR, PROFILE_ACL_MARKER_NAME),
      data: PROFILE_ACL_MARKER_CONTENT,
    },
  ]);
  assert.equal(PROFILE_ACL_MARKER_CONTENT, "1");
});

test("a missing SystemRoot fails without spawning", () => {
  const previous = process.env.SystemRoot;
  delete process.env.SystemRoot;
  try {
    const { calls, deps } = depsWith();
    const { runner, fileSystem } = deps;
    const result = hardenProfileDirectory(PROBE_DIR, PROBE_SID, {
      runner,
      fileSystem,
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  } finally {
    if (previous !== undefined) {
      process.env.SystemRoot = previous;
    }
  }
});

test("a non-absolute SystemRoot fails without spawning", () => {
  const { calls, deps } = depsWith({ systemRoot: "Windows" });
  assert.equal(hardenProfileDirectory(PROBE_DIR, PROBE_SID, deps).ok, false);
  assert.equal(calls.length, 0);
});

test("real Windows: hardening removes the Users grant from the whole subtree", async (t) => {
  if (process.platform !== "win32") {
    t.skip("requires Windows NTFS ACLs");
    return;
  }
  const { resolveCurrentUserSidSync } =
    await import("../../src/main/windows-user-identity.ts");
  const identity = resolveCurrentUserSidSync();
  assert.equal(identity.ok, true, "the Windows process SID query must succeed");
  if (!identity.ok) {
    return;
  }
  const sid = identity.sid;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const runPowerShell = (script) =>
    spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, encoding: "utf8" },
    );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ytvw-acl-"));
  t.after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const userDirectory = path.join(scratch, "users", "by-sid", sid);
  const profileDirectory = path.join(userDirectory, "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  fs.writeFileSync(path.join(profileDirectory, "seed.txt"), "seed", "utf8");
  // Reproduce the pre-fix shape: the installer grant walked the whole tree,
  // so every existing child carries a Users ACE.
  const grant = spawnSync(
    path.join(systemRoot, "System32", "icacls.exe"),
    [
      scratch,
      "/grant",
      "*S-1-5-32-545:(OI)(CI)(S,DE,RC,RD,WD,AD,REA,WEA,X,RA,WA)",
      "/T",
      "/C",
      "/Q",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(
    grant.status,
    0,
    `the installer-shaped grant must apply: ${grant.stderr}`,
  );

  // An elevated shell creates directories owned by Administrators; the app
  // runs unelevated and owns its own directory. Reproduce that ownership so
  // the owner guard in hardenProfileDirectory is exercised as in production.
  const setOwner = runPowerShell(
    `$di=New-Object System.IO.DirectoryInfo -ArgumentList '${userDirectory}';` +
      `$sec=$di.GetAccessControl();` +
      `$sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('${sid}')));` +
      `$di.SetAccessControl($sec)`,
  );
  assert.equal(
    setOwner.status,
    0,
    `setting the owner must succeed: ${setOwner.stderr}`,
  );

  const result = hardenProfileDirectory(userDirectory, sid);
  assert.deepEqual(result, { ok: true });

  const readSddl = (target) => {
    const queried = runPowerShell(
      `(New-Object System.IO.DirectoryInfo -ArgumentList '${target}').GetAccessControl().Sddl`,
    );
    assert.equal(queried.status, 0, `reading the SDDL failed on ${target}`);
    return queried.stdout.trim();
  };
  for (const target of [
    userDirectory,
    profileDirectory,
    path.join(profileDirectory, "seed.txt"),
  ]) {
    const sddl = readSddl(target);
    assert.doesNotMatch(
      sddl,
      /S-1-5-32-545/,
      `no Users ACE may remain on ${target}; SDDL: ${sddl}`,
    );
  }
  const userSddl = readSddl(userDirectory);
  for (const ace of ["SY", "BA"]) {
    assert.ok(
      userSddl.includes(`(A;OICI;FA;;;${ace})`),
      `the SID directory must grant full control to ${ace}; SDDL: ${userSddl}`,
    );
  }
  // The owner ACE appears as the literal SID for an ordinary account, but
  // Windows renders the built-in Administrator (RID 500, as on CI) as the
  // "LA" alias, so accept either form.
  assert.ok(
    userSddl.includes(`(A;OICI;FA;;;${sid})`) ||
      userSddl.includes("(A;OICI;FA;;;LA)"),
    `the SID directory must grant full control to the owner; SDDL: ${userSddl}`,
  );
  // The owner still works in its own tree: read, write, append, delete.
  const probe = path.join(profileDirectory, "owner-probe.txt");
  fs.writeFileSync(probe, "owner write", "utf8");
  fs.appendFileSync(probe, "+append", "utf8");
  assert.equal(fs.readFileSync(probe, "utf8"), "owner write+append");
  fs.rmSync(probe);
});
