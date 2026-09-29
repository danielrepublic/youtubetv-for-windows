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
  process.env.YTVW_RELEASE_WORKFLOW_PATH ??
  join(repositoryRoot, ".github", "workflows", "release.yml");
const workflowSteps = [
  "Checkout the protected tag",
  "Set up Node.js",
  "Validate the protected stable version tag",
  "Install, test, and package",
  "Refuse to overwrite an existing release version",
  "Write bilingual release notes",
  "Publish immutable GitHub Release assets",
];
const actionPins = [
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "249970729cb0ef3589644e2896645e5dc5ba9c38"],
];
const forbiddenReferences = [
  "RELEASE_ED25519_PRIVATE_KEY",
  "update-manifest",
  "auto-update",
  "rollback",
  ".sig",
  ".sha256",
  "release-assets",
  "Copy-Item",
  "secrets.",
];

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

function stepIndex(source, name) {
  return source.indexOf(`      - name: ${name}\n`);
}

function workflowStepsFrom(job) {
  return [...job.matchAll(/^ {6}- (?:name: (.+)|.+)$/gm)].map(
    (match) => match[1] ?? "<unnamed>",
  );
}

function uploadedAssets(command) {
  const trimmedCommand = command?.trimStart();
  const beforeOptions = trimmedCommand?.indexOf(" --repo ") ?? -1;
  if (beforeOptions < 0) {
    return [];
  }
  return trimmedCommand
    .slice("gh release create $env:GITHUB_REF_NAME".length, beforeOptions)
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => token.replace(/^"|"$/g, ""));
}

function validateReleaseWorkflow(source) {
  const failures = [];
  const publish = jobBody(source, "publish");
  const publishCommand = /^\s*gh release create .+$/m.exec(publish ?? "")?.[0];
  const refuseIndex = stepIndex(
    publish ?? "",
    "Refuse to overwrite an existing release version",
  );
  const notesIndex = stepIndex(publish ?? "", "Write bilingual release notes");
  const publishIndex = stepIndex(
    publish ?? "",
    "Publish immutable GitHub Release assets",
  );

  failureIf(
    !/on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"/.test(source) ||
      /\n\s*(?:pull_request|pull_request_target|workflow_run|workflow_dispatch):/.test(
        source,
      ),
    "release workflow must use a version-tag-only push trigger",
    failures,
  );
  failureIf(
    !/^permissions: \{\}$/m.test(source),
    "workflow permissions must default to none",
    failures,
  );
  failureIf(
    publish === undefined ||
      !/github\.event_name == 'push' && github\.ref_type == 'tag' &&\s+github\.ref_protected && startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(
        publish,
      ) ||
      !/environment:\s*\n\s+name: release/.test(publish) ||
      !/permissions:\s*\n\s+contents: write/.test(publish),
    "publish must require a protected release environment and protected tag ref",
    failures,
  );
  failureIf(
    !/\$version = \(Get-Content package\.json -Raw \| ConvertFrom-Json\)\.version/.test(
      source,
    ) || !/if \(\$tag -ne "v\$version"\)/.test(source),
    "release tag must equal the package.json version",
    failures,
  );
  failureIf(
    [
      "npm ci",
      "npm run typecheck",
      "npm run test:unit",
      "npm run lint",
      "npm run format:check",
      "npm run package",
      "npm run verify:artifacts",
    ].some((command) => !publish?.includes(command)),
    "publish must install, verify, package, and verify artifacts before release creation",
    failures,
  );
  failureIf(
    JSON.stringify(workflowStepsFrom(publish ?? "")) !==
      JSON.stringify(workflowSteps),
    "release workflow must contain only the ordered plain-release steps",
    failures,
  );
  failureIf(
    refuseIndex < 0 ||
      notesIndex < 0 ||
      publishIndex < 0 ||
      !(refuseIndex < notesIndex && notesIndex < publishIndex) ||
      !/gh release view \$env:GITHUB_REF_NAME/.test(publish ?? "") ||
      !/Refusing to overwrite existing release/.test(publish ?? ""),
    "publish must refuse an existing release version before publication",
    failures,
  );
  failureIf(
    JSON.stringify(uploadedAssets(publishCommand)) !==
      JSON.stringify(["release-output/$installer"]),
    "publish asset set must be exactly the versioned installer from release-output",
    failures,
  );
  failureIf(
    !/## 繁體中文/.test(source) ||
      !/## English/.test(source) ||
      !publishCommand?.includes(
        '--notes-file "$env:RUNNER_TEMP/release-notes.md"',
      ),
    "release notes must be bilingual and supplied from a notes file",
    failures,
  );
  failureIf(
    /continue-on-error\s*:/.test(source),
    "release workflow must not continue after a failed step",
    failures,
  );
  for (const reference of forbiddenReferences) {
    failureIf(
      source.includes(reference),
      `release workflow must not reference ${reference}`,
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

test("the release workflow keeps the protected plain-release policy", () => {
  assert.deepEqual(
    validateReleaseWorkflow(readFileSync(workflowPath, "utf8")),
    [],
  );
});

test("each required workflow policy defect fails in a byte-restored scratch copy", (testContext) => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "ytvw-release-policy-"));
  const scratchWorkflow = join(scratchDirectory, "release.yml");
  const original = readFileSync(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
  );
  writeFileSync(scratchWorkflow, original);
  testContext.after(() =>
    rmSync(scratchDirectory, { recursive: true, force: true }),
  );
  const defects = [
    [
      "non-tag release trigger",
      (source) =>
        replaceOnce(
          source,
          '    tags:\n      - "v*.*.*"',
          "    branches:\n      - main",
        ),
      /version-tag-only push trigger/,
    ],
    [
      "workflow default permissions",
      (source) =>
        replaceOnce(source, "permissions: {}", "permissions: read-all"),
      /permissions must default to none/,
    ],
    [
      "protected release ref",
      (source) =>
        replaceOnce(
          source,
          "github.ref_protected && startsWith(github.ref, 'refs/tags/v')",
          "startsWith(github.ref, 'refs/tags/v')",
        ),
      /protected release environment and protected tag ref/,
    ],
    [
      "package version equality",
      (source) =>
        replaceOnce(
          source,
          'if ($tag -ne "v$version")',
          'if ($tag -eq "v$version")',
        ),
      /release tag must equal the package.json version/,
    ],
    [
      "required verification command",
      (source) => replaceOnce(source, "npm run lint", "npm lint"),
      /must install, verify, package, and verify artifacts/,
    ],
    [
      "ordered plain-release steps",
      (source) =>
        replaceOnce(
          source,
          "      - name: Set up Node.js",
          "      - name: Configure Node.js",
        ),
      /must contain only the ordered plain-release steps/,
    ],
    [
      "release overwrite guard",
      (source) =>
        replaceOnce(
          source,
          "gh release view $env:GITHUB_REF_NAME",
          "gh release list $env:GITHUB_REF_NAME",
        ),
      /must refuse an existing release version before publication/,
    ],
    [
      "signing secret reference",
      (source) => `${source}\n# RELEASE_ED25519_PRIVATE_KEY\n`,
      /must not reference RELEASE_ED25519_PRIVATE_KEY/,
    ],
    [
      "two-file asset list",
      (source) =>
        replaceOnce(
          source,
          '"release-output/$installer" --repo',
          '"release-output/$installer" "release-output/second.exe" --repo',
        ),
      /asset set must be exactly/,
    ],
    [
      "bilingual release notes",
      (source) => replaceOnce(source, "          ## English\n", ""),
      /release notes must be bilingual and supplied from a notes file/,
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
        validateReleaseWorkflow(readFileSync(scratchWorkflow, "utf8")).join(
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
