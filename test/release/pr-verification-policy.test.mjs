import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const workflowPath =
  process.env.YTVW_PR_VERIFY_WORKFLOW_PATH ??
  join(repositoryRoot, ".github", "workflows", "pr-verify.yml");
const workflowSteps = [
  "Checkout the pull request",
  "Set up Node.js",
  "Install and verify",
];
const actionPins = [
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
];
const requiredCommands = [
  "npm ci",
  "npm run typecheck",
  "npm run test:unit",
  "npm run lint",
  "npm run format:check",
  "npm run test:electron",
];
const forbiddenReferences = ["secrets.", "gh release", "npm publish"];

function failureIf(condition, message, failures) {
  if (condition) {
    failures.push(message);
  }
}

function jobBody(source, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const followingJobs = source
    .slice(start + marker.length)
    .search(/\n {2}\w+:\n/);
  return followingJobs < 0
    ? source.slice(start)
    : source.slice(start, start + marker.length + followingJobs);
}

function workflowStepsFrom(job) {
  return [...job.matchAll(/^ {6}- (?:name: (.+)|.+)$/gm)].map(
    (match) => match[1] ?? "<unnamed>",
  );
}

function validatePrVerifyWorkflow(source) {
  const failures = [];
  const hasPushTrigger = /^\s+push:/m.test(source);

  failureIf(
    !/^\s+pull_request:/m.test(source),
    "pr verification must trigger on pull_request",
    failures,
  );
  failureIf(
    /\n\s*(?:pull_request_target|workflow_run|workflow_dispatch):/.test(source),
    "pr verification must not use privileged or manual triggers",
    failures,
  );
  failureIf(
    hasPushTrigger && !/push:\s*\n\s+branches:\s*\n\s+- master/.test(source),
    "an optional push trigger may only target the master branch",
    failures,
  );
  failureIf(
    !/^permissions: \{\}$/m.test(source),
    "workflow permissions must default to none",
    failures,
  );
  failureIf(
    !/runs-on: windows-latest/.test(source),
    "pr verification must run on windows-latest",
    failures,
  );
  failureIf(
    !/permissions:\s*\n\s+contents: read/.test(source),
    "the verify job must hold only contents: read",
    failures,
  );
  failureIf(
    !/node-version: 24\.19\.0/.test(source) || !/cache: npm/.test(source),
    "pr verification must use Node.js 24.19.0 with the npm cache",
    failures,
  );
  failureIf(
    requiredCommands.some((command) => !source.includes(command)),
    "pr verification must install and run every static and Electron gate",
    failures,
  );
  failureIf(
    !source.includes("npm run test:electron"),
    "pr verification must include the npm run test:electron gate",
    failures,
  );
  failureIf(
    JSON.stringify(workflowStepsFrom(jobBody(source, "verify") ?? "")) !==
      JSON.stringify(workflowSteps),
    "pr verification must contain only the ordered verification steps",
    failures,
  );
  failureIf(
    /continue-on-error\s*:/.test(source),
    "pr verification must not continue after a failed step",
    failures,
  );
  for (const reference of forbiddenReferences) {
    failureIf(
      source.includes(reference),
      `pr verification must not reference ${reference}`,
      failures,
    );
  }
  for (const [action, sha] of actionPins) {
    failureIf(
      !source.includes(`uses: ${action}@${sha}`),
      `${action} must use its documented immutable commit SHA`,
      failures,
    );
  }
  const actionReferences = [...source.matchAll(/^\s+uses:\s+\S+@([^\s#]+)/gm)];
  failureIf(
    actionReferences.length === 0 ||
      actionReferences.some((match) => !/^[0-9a-f]{40}$/.test(match[1])),
    "every action must be pinned to a full commit SHA",
    failures,
  );
  return failures;
}

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  assert.notEqual(
    index,
    -1,
    `scratch mutation precondition missing: ${before}`,
  );
  return `${source.slice(0, index)}${after}${source.slice(
    index + before.length,
  )}`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapedExpression(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("the pr verification workflow keeps the pull-request gate policy", () => {
  assert.deepEqual(
    validatePrVerifyWorkflow(readFileSync(workflowPath, "utf8")),
    [],
  );
});

test("each required workflow policy defect fails in a byte-restored scratch copy", (testContext) => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "ytvw-pr-policy-"));
  const scratchWorkflow = join(scratchDirectory, "pr-verify.yml");
  const original = readFileSync(
    join(repositoryRoot, ".github", "workflows", "pr-verify.yml"),
  );
  writeFileSync(scratchWorkflow, original);
  testContext.after(() =>
    rmSync(scratchDirectory, { recursive: true, force: true }),
  );
  const defects = [
    [
      "pull_request trigger",
      (source) =>
        replaceOnce(source, "  pull_request:", "  pull_request_target:"),
      /must trigger on pull_request/,
    ],
    [
      "privileged trigger",
      (source) => `${source}\nworkflow_dispatch:\n`,
      /must not use privileged or manual triggers/,
    ],
    [
      "push branch restriction",
      (source) => replaceOnce(source, "      - master", "      - main"),
      /may only target the master branch/,
    ],
    [
      "workflow default permissions",
      (source) =>
        replaceOnce(source, "permissions: {}", "permissions: read-all"),
      /permissions must default to none/,
    ],
    [
      "windows runner",
      (source) =>
        replaceOnce(
          source,
          "runs-on: windows-latest",
          "runs-on: ubuntu-latest",
        ),
      /must run on windows-latest/,
    ],
    [
      "read-only job permissions",
      (source) => replaceOnce(source, "contents: read", "contents: write"),
      /must hold only contents: read/,
    ],
    [
      "node version pin",
      (source) =>
        replaceOnce(source, "node-version: 24.19.0", "node-version: 24.x"),
      /must use Node\.js 24\.19\.0 with the npm cache/,
    ],
    [
      "required verification command",
      (source) => replaceOnce(source, "npm run lint", "npm lint"),
      /must install and run every static and Electron gate/,
    ],
    [
      "electron verification gate",
      (source) =>
        replaceOnce(source, "npm run test:electron", "npm lint:electron"),
      /must include the npm run test:electron gate/,
    ],
    [
      "ordered verification steps",
      (source) =>
        replaceOnce(
          source,
          "      - name: Install and verify",
          "      - name: Verify things",
        ),
      /must contain only the ordered verification steps/,
    ],
    [
      "continue-on-error",
      (source) => `${source}\ncontinue-on-error: true\n`,
      /must not continue after a failed step/,
    ],
    [
      "documented action pin",
      (source) =>
        replaceOnce(
          source,
          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "actions/checkout@0000000000000000000000000000000000000000",
        ),
      /actions\/checkout must use its documented immutable commit SHA/,
    ],
    [
      "full action SHA pin",
      (source) =>
        replaceOnce(
          source,
          "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
          "actions/setup-node@v6",
        ),
      /every action must be pinned to a full commit SHA/,
    ],
    ...forbiddenReferences.map((reference) => [
      `forbidden ${reference} reference`,
      (source) => `${source}\n# ${reference}\n`,
      escapedExpression(`must not reference ${reference}`),
    ]),
  ];
  for (const [name, mutate, expected] of defects) {
    const before = readFileSync(scratchWorkflow);
    const beforeSha256 = sha256(before);
    try {
      writeFileSync(scratchWorkflow, mutate(before.toString("utf8")));
      assert.match(
        validatePrVerifyWorkflow(readFileSync(scratchWorkflow, "utf8")).join(
          "\n",
        ),
        expected,
        name,
      );
    } finally {
      writeFileSync(scratchWorkflow, before);
    }
    const restored = readFileSync(scratchWorkflow);
    assert.equal(sha256(restored), beforeSha256, `${name} SHA-256 restore`);
    assert.deepEqual(restored, before, `${name} byte-identical restore`);
  }
});
