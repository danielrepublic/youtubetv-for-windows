// Shared spawn harness for the todo-3 policy integration suites.
//
// Spawns the Electron binary as a subprocess running
// test/electron/fixture-host.mjs with a --scenario argument, parses its
// JSON-lines report, and always reaps the process tree (timeout kill on
// Windows). Not a suite file (no .test.mjs suffix), so the chain runner
// never picks it up directly.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SPAWN_TIMEOUT_MS = 90000;

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

export function electronBinaryPath() {
  const pathTxt = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "path.txt",
  );
  assert.ok(
    fs.existsSync(pathTxt),
    "node_modules/electron/path.txt is missing: run `npm run clean-install` first",
  );
  const binaryName = fs.readFileSync(pathTxt, "utf8").trim();
  const binaryPath = path.join(
    repositoryRoot,
    "node_modules",
    "electron",
    "dist",
    binaryName,
  );
  assert.ok(
    fs.existsSync(binaryPath),
    `Electron binary missing: ${binaryPath}`,
  );
  return binaryPath;
}

export function killProcessTree(pid) {
  if (pid === undefined) {
    return;
  }
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

export function spawnFixtureHost(fixtureArgs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronBinaryPath(),
      [path.join("test", "electron", "fixture-host.mjs"), ...fixtureArgs],
      {
        cwd: repositoryRoot,
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, SPAWN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const records = [];
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("{")) {
          try {
            records.push(JSON.parse(trimmed));
          } catch {
            // Non-JSON Electron banner lines are ignored.
          }
        }
      }
      resolve({ exitCode, timedOut, records, stdout, stderr });
    });
  });
}

export function recordOf(records, event) {
  const found = records.find((record) => record.event === event);
  assert.ok(found, `expected a "${event}" report line`);
  return found;
}

export function assertCleanRun(run) {
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  assert.ok(
    recordOf(run.records, "done"),
    "the fixture host must finish its scenario",
  );
}

// Starts a local deterministic HTTP fixture server. The responder maps a
// request URL pathname to { status, headers, body }; every request is
// logged for assertions.
export async function startFixtureServer(t, responder) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, method: request.method });
    const outcome =
      responder === undefined
        ? undefined
        : responder(request.url ?? "/", request);
    const status = outcome?.status ?? 200;
    const body =
      outcome?.body ??
      "<!doctype html><html><head><title>fixture</title></head><body>fixture</body></html>";
    response.writeHead(status, {
      "content-type": "text/html",
      ...(outcome?.headers ?? {}),
    });
    response.end(body);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.close();
  });
  const port = server.address().port;
  return { requests, port, url: `http://127.0.0.1:${port}/`, server };
}
