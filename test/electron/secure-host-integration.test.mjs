// Spawned Electron integration suite for the secure fullscreen host.
//
// A local deterministic fixture HTTP server records received headers and
// serves a tiny page (never live YouTube). Each scenario spawns the Electron
// binary as a subprocess running test/electron/fixture-host.mjs, which drives
// the COMPILED host (dist/main/, built by the pretest:electron hook) and
// reports JSON lines on stdout. Every spawn has a hard timeout with a
// process-tree kill, so a hung Electron can never hang the runner; the
// fixture server closes in teardown and the fixture calls app.quit().

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const { FIXED_USER_AGENT } = await import("../../src/main/user-agent.ts");

const SPAWN_TIMEOUT_MS = 90000;
const FIXTURE_HTML =
  "<!doctype html><html><head><title>fixture</title></head><body>fixture</body></html>";

function electronBinaryPath() {
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

function killProcessTree(pid) {
  if (pid === undefined) {
    return;
  }
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
}

async function startFixtureServer(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      url: request.url,
      userAgent: request.headers["user-agent"] ?? null,
    });
    response.writeHead(200, { "content-type": "text/html" });
    response.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.close();
  });
  const port = server.address().port;
  return { requests, url: `http://127.0.0.1:${port}/` };
}

// Spawns Electron with the fixture host, parses its JSON-lines report, and
// always reaps the process tree (timeout kill on Windows).
function spawnFixtureHost(fixtureArgs, extraEnv = {}) {
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

function recordOf(records, event) {
  const found = records.find((record) => record.event === event);
  assert.ok(found, `expected a "${event}" report line`);
  return found;
}

test("the fixture server sees the fixed PS4 identity on every request", async (t) => {
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost([fixture.url]);
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  assert.ok(
    recordOf(run.records, "done"),
    "the fixture host must finish its scenario",
  );
  assert.ok(
    fixture.requests.length > 0,
    "the fixture server must have received requests",
  );
  for (const request of fixture.requests) {
    assert.equal(request.userAgent, FIXED_USER_AGENT);
  }
});

test("the page context reports the fixed identity and a locked-down renderer", async (t) => {
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost([fixture.url]);
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  const policy = recordOf(run.records, "policy");
  assert.equal(policy.userAgent, FIXED_USER_AGENT);
  assert.equal(policy.headerInterceptionActive, true);
  assert.equal(policy.sessionUserAgent, FIXED_USER_AGENT);
  const environment = recordOf(run.records, "environment");
  assert.equal(environment.preloadExists, true);
  const probe = recordOf(run.records, "probe");
  assert.equal(probe.ua, FIXED_USER_AGENT);
  // The preload runs in an isolated JavaScript world, so its window expando
  // is intentionally invisible to the page; the shared-DOM witness attribute
  // is the cross-world proof that the sandboxed CJS preload executed. An ESM
  // emit would fail to load under sandbox:true and leave no witness.
  assert.equal(probe.domWitness, "preload-loaded");
  assert.equal(probe.requireType, "undefined");
  assert.equal(probe.processType, "undefined");
});

test("the window opens fullscreen and F11 toggles it both ways", async (t) => {
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost([fixture.url]);
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  const initial = recordOf(run.records, "fullscreen-initial");
  assert.equal(initial.isFullScreen, true);
  const keys = recordOf(run.records, "keys");
  assert.ok(
    keys.observedKeys.some((entry) => entry.endsWith(":F11")),
    `expected an F11 before-input-event, saw ${keys.observedKeys}`,
  );
  assert.equal(keys.afterFirstF11, false);
  assert.equal(keys.afterSecondF11, true);
});

test("Esc never exits fullscreen at the host layer", async (t) => {
  // YouTube TV owns Esc inside its page (exiting its own overlays/players);
  // the host must simply never bind it. What the live YouTube page does with
  // Esc is page behavior and out of host scope; this fixture page has no Esc
  // handler, so any exit would prove host interception.
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost([fixture.url]);
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  const keys = recordOf(run.records, "keys");
  assert.equal(keys.afterEsc, true);
});

test("a mutated identity fails activation and never reaches the server", async (t) => {
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost(["--mutated"]);
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  const gate = recordOf(run.records, "mutation-rejected");
  assert.equal(gate.rejected, true);
  assert.equal(
    fixture.requests.length,
    0,
    "a rejected identity must produce zero requests",
  );
});

test("env and CLI user-agent overrides cannot change the fixed identity", async (t) => {
  const fixture = await startFixtureServer(t);
  const run = await spawnFixtureHost([fixture.url, "--user-agent=evil"], {
    YOUTUBE_TV_USER_AGENT: "evil",
  });
  assert.equal(run.timedOut, false, `fixture host timed out: ${run.stderr}`);
  assert.equal(run.exitCode, 0, `fixture host failed: ${run.stderr}`);
  const probe = recordOf(run.records, "probe");
  assert.equal(probe.ua, FIXED_USER_AGENT);
  assert.ok(
    fixture.requests.length > 0,
    "the fixture server must have received requests",
  );
  for (const request of fixture.requests) {
    assert.equal(request.userAgent, FIXED_USER_AGENT);
  }
});
