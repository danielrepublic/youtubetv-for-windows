import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const shellArguments = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
];
const systemEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|ComSpec|TEMP|TMP|PATHEXT)$/i.test(name),
  ),
);

function findPowerShell() {
  assert.equal(
    process.platform,
    "win32",
    "native .cmd fixtures require Windows",
  );
  for (const candidate of [
    "pwsh.exe",
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  ]) {
    const probe = spawnSync(
      candidate,
      [
        ...shellArguments,
        "-Command",
        "(@{path=(Get-Process -Id $PID).Path; version=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition} | ConvertTo-Json -Compress)",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...systemEnvironment, PATH: process.env.PATH },
      },
    );
    if (probe.error?.code === "ENOENT") continue;
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, probe.stderr);
    return JSON.parse(probe.stdout.trim());
  }
  assert.fail("Install-free test requires an existing PowerShell executable");
}

const powerShell = findPowerShell();

function stepScript(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow step missing: ${name}`);
  const rest = workflow.slice(start + marker.length);
  const end = rest.indexOf("\n      - ");
  const step = end < 0 ? rest : rest.slice(0, end);
  const block = /^ {8}run: \|\n((?: {10}[^\n]*\n?|\n)+)/m.exec(step);
  assert.ok(block, `literal run block missing: ${name}`);
  return block[1].replace(/^ {10}/gm, "");
}

function runStep(testContext, name, stubEnvironment) {
  const directory = mkdtempSync(join(tmpdir(), "ytvw-powershell-exit-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "commands.log");
  writeFileSync(log, "");
  writeFileSync(
    join(directory, "gh.cmd"),
    [
      "@echo off",
      'echo gh %*>>"%STUB_COMMAND_LOG%"',
      'if not "%~1 %~2"=="release view" exit /b 99',
      "exit /b %STUB_GH_STATUS%",
      "",
    ].join("\r\n"),
  );
  writeFileSync(
    join(directory, "npm.cmd"),
    [
      "@echo off",
      'echo npm %*>>"%STUB_COMMAND_LOG%"',
      'if "%~1 %~2"=="run test:unit" exit /b 17',
      "exit /b 0",
      "",
    ].join("\r\n"),
  );
  const script = join(directory, "step.ps1");
  // Actions runner ScriptHandler/FixUpScriptContents prepends Stop and appends LASTEXITCODE propagation.
  writeFileSync(
    script,
    [
      "$ErrorActionPreference = 'stop'",
      stepScript(name),
      "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }",
      "",
    ].join("\n"),
  );
  const result = spawnSync(
    powerShell.path,
    [...shellArguments, "-File", script],
    {
      cwd: directory,
      env: {
        ...systemEnvironment,
        PATH: directory,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        GITHUB_REF_NAME: "v0.1.1",
        GITHUB_REPOSITORY: "fixture-owner/fixture-repository",
        STUB_COMMAND_LOG: log,
        ...stubEnvironment,
      },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.ifError(result.error);
  const commands = readFileSync(log, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  testContext.diagnostic(
    `${powerShell.edition} PowerShell ${powerShell.version}; status=${result.status}; commands=${JSON.stringify(commands)}`,
  );
  return { status: result.status, commands, stderr: result.stderr };
}

const releaseGuard = "Refuse to overwrite an existing release version";
const releaseLookup =
  "gh release view v0.1.1 --repo fixture-owner/fixture-repository";

test("release guard succeeds when the release lookup reports absence", (testContext) => {
  const environment = { STUB_GH_STATUS: "1" };

  const result = runStep(testContext, releaseGuard, environment);

  assert.deepEqual(result.commands, [releaseLookup]);
  assert.equal(
    result.status,
    0,
    "expected release absence must not fail the Actions step",
  );
});

test("release guard blocks when the release lookup finds an existing version", (testContext) => {
  const environment = { STUB_GH_STATUS: "0" };

  const result = runStep(testContext, releaseGuard, environment);

  assert.deepEqual(result.commands, [releaseLookup]);
  assert.equal(result.status, 1, "existing release must fail the Actions step");
  assert.match(
    result.stderr,
    /Refusing to overwrite existing release v0\.1\.1/,
  );
});

test("packaging stops and preserves the exit code when an earlier npm stage fails", (testContext) => {
  const expected = {
    status: 17,
    commands: ["npm ci", "npm run typecheck", "npm run test:unit"],
  };

  const result = runStep(testContext, "Install, test, and package", {});

  assert.deepEqual(
    { status: result.status, commands: result.commands },
    expected,
  );
});
