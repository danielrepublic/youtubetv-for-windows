import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateRecord } = require("../../scripts/verify-certification.cjs");

const CANDIDATE = "1.2.3";
const DATE = "2026-09-29";
const ATTACHMENT_DIRECTORY = `release-evidence/certification/${CANDIDATE}-${DATE}`;

function syntheticRecord(overrides = {}) {
  const values = {
    status: "passed",
    candidate: CANDIDATE,
    certifiedDate: DATE,
    device: "Synthetic fixture device (not real certification evidence)",
    windows: "Synthetic Windows 11 build (not real certification evidence)",
    electron: "44.4.5",
    app: CANDIDATE,
    display: "Synthetic 4K display, 3840x2160",
    network: "250 Mbps via synthetic speedtest method on 2026-09-29",
    video: "https://www.youtube.com/watch?v=synthetic4k",
    stats: "Synthetic screenshot reference showing current 3840x2160 / 2160p",
    gate1: "passed",
    account: "ordinary synthetic test account type (no identifier)",
    child: "passed",
    relaunch: "passed",
    gate2: "passed",
    phone: "Synthetic phone model with YouTube app 19.01",
    wifi: "yes",
    target: "passed",
    control: "passed",
    gate3: "passed",
    ...overrides,
  };
  return `<!-- COMPLETE SYNTHETIC FIXTURE ONLY: never real certification evidence. -->
Status: ${values.status}
Candidate version: ${values.candidate}
Certified date: ${values.certifiedDate}
Certified by: Maintainer synthetic fixture
Release page: https://github.com/danielrepublic/youtubetv-for-windows/releases/tag/v${values.candidate}

## Environment
| Field | Value |
| --- | --- |
| Device model | ${values.device} |
| Windows version / build | ${values.windows} |
| Electron version | ${values.electron} |
| App version | ${values.app} |

## Hard gate 1
| Field | Value |
| --- | --- |
| Display model and resolution | ${values.display} |
| Network measurement (>= 25 Mbps) | ${values.network} |
| Public 4K video URL | ${values.video} |
| Stats-for-nerds capture | ${values.stats} |
| Result | ${values.gate1} |

## Hard gate 2
| Field | Value |
| --- | --- |
| Ordinary test account type | ${values.account} |
| Sign-in completed in child flow | ${values.child} |
| Still signed in after full relaunch | ${values.relaunch} |
| Result | ${values.gate2} |

## Hard gate 3
| Field | Value |
| --- | --- |
| Phone model and YouTube app version | ${values.phone} |
| Same Wi-Fi confirmed | ${values.wifi} |
| Desktop appears as a target device | ${values.target} |
| Playback controlled from the phone | ${values.control} |
| Result | ${values.gate3} |

## Evidence attachments

release-evidence/certification/${CANDIDATE}-${DATE}/
`;
}

function writeFixture(recordText = syntheticRecord()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "certification-"));
  const recordPath = path.join(root, "record.md");
  const attachmentRoot = path.join(root, ATTACHMENT_DIRECTORY);
  fs.mkdirSync(attachmentRoot, { recursive: true });
  fs.writeFileSync(recordPath, recordText, "utf8");
  for (const name of [
    "environment.md",
    "network.md",
    "signin-relaunch.md",
    "phone-pairing.md",
    "guard-result.log",
  ]) {
    fs.writeFileSync(
      path.join(attachmentRoot, name),
      `${CANDIDATE} ${DATE} synthetic fixture; no live evidence.\n`,
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(attachmentRoot, "stats-for-nerds.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  return { root, recordPath };
}

function assertDefect(name, overrides, expected) {
  test(`rejects ${name}`, () => {
    const fixture = writeFixture(syntheticRecord(overrides));
    const before = crypto
      .createHash("sha256")
      .update(fs.readFileSync(fixture.recordPath))
      .digest("hex");
    const result = validateRecord(fixture.recordPath, CANDIDATE);
    assert.notDeepEqual(result.failures, []);
    assert.ok(
      result.failures.some((failure) => failure.includes(expected)),
      result.failures.join("\n"),
    );
    const cli = spawnSync(
      process.execPath,
      [
        "scripts/verify-certification.cjs",
        fixture.recordPath,
        "--candidate-version",
        CANDIDATE,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(cli.status, 0);
    assert.match(
      cli.stderr,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    fs.writeFileSync(fixture.recordPath, syntheticRecord(), "utf8");
    const after = crypto
      .createHash("sha256")
      .update(fs.readFileSync(fixture.recordPath))
      .digest("hex");
    assert.equal(
      after,
      crypto.createHash("sha256").update(syntheticRecord()).digest("hex"),
    );
    assert.notEqual(
      before,
      after,
      "the planted defect must have changed the scratch copy",
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
}

test("accepts the complete synthetic fixture and labels it non-real", () => {
  const fixture = writeFixture();
  const result = validateRecord(fixture.recordPath, CANDIDATE);
  assert.deepEqual(result.failures, []);
  assert.match(
    fs.readFileSync(fixture.recordPath, "utf8"),
    /COMPLETE SYNTHETIC FIXTURE ONLY/,
  );
  const cli = spawnSync(
    process.execPath,
    [
      "scripts/verify-certification.cjs",
      fixture.recordPath,
      "--candidate-version",
      CANDIDATE,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /\[verify:certification\] PASS/);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

assertDefect(
  "a missing required field",
  { display: "" },
  "missing hard gate 1 Display model and resolution",
);
assertDefect(
  "an unfilled placeholder",
  { stats: "[pending, screenshot showing current 3840x2160 / 2160p]" },
  "unfilled placeholder",
);
assertDefect(
  "a non-2160p result",
  { display: "Synthetic display, 1920x1080" },
  "must show 3840x2160",
);
assertDefect(
  "a failed hard gate",
  { gate2: "blocked" },
  "hard gate 2 Result must be passed",
);
assertDefect("a stale version binding", { app: "1.2.2" }, "App version");
assertDefect(
  "a secret-bearing value",
  {
    account:
      "ordinary account type; account identifier 01234567890123456789012345678901",
  },
  "secret-bearing",
);
assertDefect(
  "a blocked status",
  { status: "blocked" },
  "Status must be passed",
);
