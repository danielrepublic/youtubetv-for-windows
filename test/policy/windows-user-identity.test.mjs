import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveCurrentUserSidSync } from "../../src/main/windows-user-identity.ts";
import { SID_ADA, SID_BOB } from "./profile-test-fixtures.mjs";

test("the SID query parses bytes and uses bounded system PowerShell", () => {
  const calls = [];
  const runner = (file, args, options) => {
    calls.push({ file, args, options });
    return Buffer.from(`  ${SID_ADA}\r\n`, "utf8");
  };

  const result = resolveCurrentUserSidSync(runner);

  assert.deepEqual(result, { ok: true, sid: SID_ADA });
  assert.deepEqual(calls, [
    {
      file: path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      ],
      options: { timeout: 5000, windowsHide: true, maxBuffer: 65536 },
    },
  ]);
});

test("the SID query accepts an Azure AD account SID", () => {
  const sid = "S-1-12-1-1000-2000-3000-1003";
  const result = resolveCurrentUserSidSync(() => `${sid}\n`);
  assert.deepEqual(result, { ok: true, sid });
});

test("the SID query fails closed on unusable output", () => {
  const unusable = [
    "",
    "   \n",
    "no-such-token",
    "S-1-5-xyz",
    `${SID_ADA}\n${SID_BOB}`,
    `${SID_ADA} extra`,
    "../../etc",
  ];
  for (const output of unusable) {
    const result = resolveCurrentUserSidSync(() => output);
    assert.equal(result.ok, false, `must reject: ${JSON.stringify(output)}`);
  }
});

test("the SID query reports process-launch failure instead of inventing an identity", () => {
  const result = resolveCurrentUserSidSync(() => {
    throw new Error("spawn EPERM");
  });
  assert.equal(result.ok, false);
});

test("an invalid identity response is not echoed into user-facing guidance", () => {
  const privateOutput = "PRIVATE_SUBPROCESS_OUTPUT\nsecond line";
  const result = resolveCurrentUserSidSync(() => privateOutput);
  assert.equal(result.ok, false);
  assert.equal(result.reason.includes("PRIVATE_SUBPROCESS_OUTPUT"), false);
});

test("process error details are not echoed into user-facing guidance", () => {
  const result = resolveCurrentUserSidSync(() => {
    throw new Error("PRIVATE_SUBPROCESS_ERROR\nstderr content");
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason.includes("PRIVATE_SUBPROCESS_ERROR"), false);
});

test("a missing Windows root fails before invoking any executable", (t) => {
  const previous = process.env.SystemRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  });
  delete process.env.SystemRoot;
  let calls = 0;

  const result = resolveCurrentUserSidSync(() => {
    calls++;
    return SID_ADA;
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("Windows on a different drive selects that system PowerShell", (t) => {
  const previous = process.env.SystemRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  });
  process.env.SystemRoot = "D:\\Windows";
  let executable;

  const result = resolveCurrentUserSidSync((file) => {
    executable = file;
    return SID_ADA;
  });

  assert.equal(result.ok, true);
  assert.equal(
    executable,
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
});

test("a relative Windows root cannot select a working-directory executable", (t) => {
  const previous = process.env.SystemRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previous;
  });
  process.env.SystemRoot = "Windows";
  let calls = 0;

  const result = resolveCurrentUserSidSync(() => {
    calls++;
    return SID_ADA;
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});
