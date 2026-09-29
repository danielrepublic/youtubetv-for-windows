"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ATTACHMENTS = [
  "environment.md",
  "network.md",
  "stats-for-nerds.png",
  "signin-relaunch.md",
  "phone-pairing.md",
  "guard-result.log",
];
const STATUSES = new Set(["awaiting-maintainer-evidence", "blocked", "passed"]);
const PLACEHOLDER = /\[\s*(?:pending|fill)[^\]]*\]/i;
const SECRET_WORD =
  /(?:password|passphrase|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|cookie|authorization\s*[:=]|bearer\s+[a-z0-9._~-]+|session(?:[_ -]?id|identifier)|account(?:[_ -]?(?:id|identifier|number)))/i;
const SECRET_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SECRET_BLOB = /(?:[a-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function valueFor(text, label) {
  const escaped = escapeRegExp(label);
  const colon = text.match(
    new RegExp(`^\\s*(?:\\|\\s*)?${escaped}\\s*:\\s*(.+?)\\s*$`, "im"),
  );
  if (colon) return colon[1].replace(/\|\s*$/, "").trim();
  const table = text.match(
    new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*$`, "im"),
  );
  return table?.[1]?.trim();
}

function sectionFor(text, heading) {
  const parts = text.split(/^##\s+/m);
  const part = parts.find((candidate) =>
    new RegExp(`^.*${escapeRegExp(heading)}.*(?:\n|$)`, "i").test(candidate),
  );
  if (!part) return "";
  const newline = part.indexOf("\n");
  return newline < 0 ? "" : part.slice(newline + 1);
}

function addValue(failures, value, label) {
  if (value === undefined || value === "") {
    failures.push(`missing ${label}`);
    return false;
  }
  if (PLACEHOLDER.test(value))
    failures.push(`${label} is an unfilled placeholder`);
  if (
    SECRET_WORD.test(value) ||
    SECRET_EMAIL.test(value) ||
    SECRET_BLOB.test(value)
  ) {
    failures.push(`${label} contains secret-bearing content`);
  }
  return true;
}

function requirePassed(failures, value, label) {
  addValue(failures, value, label);
  if (value !== "passed")
    failures.push(`${label} must be passed; found "${value ?? "missing"}"`);
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function scanReferencedText(filePath, candidate, failures, label) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    failures.push(`cannot read evidence attachment ${label}`);
    return;
  }
  const text = content.toString("utf8");
  const binaryText = content.toString("latin1");
  if (PLACEHOLDER.test(text))
    failures.push(
      `evidence attachment ${label} contains an unfilled placeholder`,
    );
  if (
    SECRET_WORD.test(binaryText) ||
    SECRET_EMAIL.test(binaryText) ||
    SECRET_BLOB.test(binaryText)
  )
    failures.push(
      `evidence attachment ${label} contains secret-bearing content`,
    );
  if (
    path.extname(filePath).toLowerCase() !== ".png" &&
    !text.includes(candidate)
  )
    failures.push(
      `evidence attachment ${label} is not bound to candidate ${candidate}`,
    );
}

function scanRecordValues(text, failures) {
  for (const line of text.split(/\r?\n/)) {
    const colon = line.match(/^\s*(?:\|\s*)?[^|:]+:\s*(.+?)\s*$/);
    const table = line.match(/^\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|\s*$/);
    const value = colon?.[1] ?? table?.[1];
    if (
      value &&
      (SECRET_WORD.test(value) ||
        SECRET_EMAIL.test(value) ||
        SECRET_BLOB.test(value))
    )
      failures.push("certification record contains secret-bearing content");
  }
}

function validateRecord(recordPath, expectedVersion) {
  const failures = [];
  let text;
  try {
    text = fs.readFileSync(recordPath, "utf8");
  } catch {
    return { failures: [`cannot read certification record ${recordPath}`] };
  }
  scanRecordValues(text, failures);

  const status = valueFor(text, "Status");
  addValue(failures, status, "Status");
  if (status !== undefined && !STATUSES.has(status))
    failures.push(`Status has unacceptable value "${status}"`);
  if (status !== "passed")
    failures.push(`Status must be passed; found "${status ?? "missing"}"`);

  const candidate = valueFor(text, "Candidate version");
  addValue(failures, candidate, "Candidate version");
  if (candidate && !VERSION.test(candidate))
    failures.push(`Candidate version is not semantic: "${candidate}"`);
  if (expectedVersion !== undefined && candidate !== expectedVersion)
    failures.push(
      `candidate version "${candidate ?? "missing"}" does not match requested version "${expectedVersion}"`,
    );

  const certifiedDate = valueFor(text, "Certified date");
  addValue(failures, certifiedDate, "Certified date");
  if (certifiedDate && !validDate(certifiedDate))
    failures.push(
      `Certified date is not a valid YYYY-MM-DD date: "${certifiedDate}"`,
    );
  addValue(failures, valueFor(text, "Certified by"), "Certified by");
  addValue(failures, valueFor(text, "Release page"), "Release page");

  for (const label of [
    "Device model",
    "Windows version / build",
    "Electron version",
    "App version",
  ]) {
    addValue(failures, valueFor(text, label), label);
  }
  const appVersion = valueFor(text, "App version");
  if (candidate && appVersion && appVersion !== candidate)
    failures.push(
      `App version "${appVersion}" is stale for candidate "${candidate}"`,
    );

  const gate1 = sectionFor(text, "Hard gate 1");
  const display = valueFor(gate1, "Display model and resolution");
  addValue(failures, display, "hard gate 1 Display model and resolution");
  if (display && !/3840\s*[x×]\s*2160/i.test(display))
    failures.push("hard gate 1 display resolution must show 3840x2160");
  const network = valueFor(gate1, "Network measurement (>= 25 Mbps)");
  addValue(failures, network, "hard gate 1 Network measurement (>= 25 Mbps)");
  const speed = network?.match(/(\d+(?:\.\d+)?)\s*Mbps/i);
  if (!speed)
    failures.push("hard gate 1 network measurement must include Mbps");
  else if (Number(speed[1]) < 25)
    failures.push(
      `hard gate 1 network measurement is below 25 Mbps: ${speed[1]}`,
    );
  if (
    network &&
    !/(?:method|via|using|speedtest|iperf|measurement)/i.test(network)
  )
    failures.push("hard gate 1 network measurement is missing its method");
  if (network && !DATE.test(network.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? ""))
    failures.push("hard gate 1 network measurement is missing its date");
  const video = valueFor(gate1, "Public 4K video URL");
  addValue(failures, video, "hard gate 1 Public 4K video URL");
  if (
    video &&
    !/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(video)
  )
    failures.push("hard gate 1 public video URL must be an HTTPS YouTube URL");
  const stats = valueFor(gate1, "Stats-for-nerds capture");
  addValue(failures, stats, "hard gate 1 Stats-for-nerds capture");
  if (stats && !/2160p|3840\s*[x×]\s*2160/i.test(stats))
    failures.push(
      "hard gate 1 Stats-for-nerds capture must show 2160p / 3840x2160",
    );
  requirePassed(failures, valueFor(gate1, "Result"), "hard gate 1 Result");

  const gate2 = sectionFor(text, "Hard gate 2");
  const account = valueFor(gate2, "Ordinary test account type");
  addValue(failures, account, "hard gate 2 Ordinary test account type");
  if (account && !/^ordinary\b/i.test(account))
    failures.push("hard gate 2 account type must be ordinary");
  requirePassed(
    failures,
    valueFor(gate2, "Sign-in completed in child flow"),
    "hard gate 2 Sign-in completed in child flow",
  );
  requirePassed(
    failures,
    valueFor(gate2, "Still signed in after full relaunch"),
    "hard gate 2 Still signed in after full relaunch",
  );
  requirePassed(failures, valueFor(gate2, "Result"), "hard gate 2 Result");

  const gate3 = sectionFor(text, "Hard gate 3");
  addValue(
    failures,
    valueFor(gate3, "Phone model and YouTube app version"),
    "hard gate 3 Phone model and YouTube app version",
  );
  const wifi = valueFor(gate3, "Same Wi-Fi confirmed");
  addValue(failures, wifi, "hard gate 3 Same Wi-Fi confirmed");
  if (wifi !== "yes")
    failures.push(
      `hard gate 3 same Wi-Fi must be yes; found "${wifi ?? "missing"}"`,
    );
  requirePassed(
    failures,
    valueFor(gate3, "Desktop appears as a target device"),
    "hard gate 3 Desktop appears as a target device",
  );
  requirePassed(
    failures,
    valueFor(gate3, "Playback controlled from the phone"),
    "hard gate 3 Playback controlled from the phone",
  );
  requirePassed(failures, valueFor(gate3, "Result"), "hard gate 3 Result");

  const attachmentLine = text.match(
    /release-evidence\/certification\/[^\s`]+/i,
  )?.[0];
  addValue(failures, attachmentLine, "Evidence attachments path");
  if (
    attachmentLine &&
    candidate &&
    certifiedDate &&
    !attachmentLine.includes(`${candidate}-${certifiedDate}`)
  )
    failures.push(
      `attachments are stale: path must bind candidate ${candidate} and date ${certifiedDate}`,
    );
  if (attachmentLine) {
    const root = path.resolve(
      path.dirname(recordPath),
      attachmentLine.replace(/\/?$/, "/"),
    );
    for (const name of ATTACHMENTS)
      scanReferencedText(
        path.join(root, name),
        candidate ?? "",
        failures,
        `${attachmentLine.replace(/\/?$/, "/")}${name}`,
      );
  }
  return { failures, candidate, date: certifiedDate };
}

function report(failures) {
  for (const failure of failures)
    process.stderr.write(`[verify:certification] FAIL ${failure}\n`);
  process.exitCode = 1;
  return 1;
}

function main() {
  const [record, flag, expectedVersion] = process.argv.slice(2);
  if (
    !record ||
    (flag !== undefined && (flag !== "--candidate-version" || !expectedVersion))
  )
    return report([
      "usage: node scripts/verify-certification.cjs <record> [--candidate-version <version>]",
    ]);
  const result = validateRecord(path.resolve(record), expectedVersion);
  if (result.failures.length > 0) return report(result.failures);
  const output = {
    status: "pass",
    generator: "scripts/verify-certification.cjs",
    record: path.relative(process.cwd(), path.resolve(record)),
    candidateVersion: result.candidate,
    certifiedDate: result.date,
    hardGates: ["actual-2160p", "sign-in-relaunch", "phone-control"],
  };
  process.stdout.write(
    `[verify:certification] PASS candidate ${result.candidate} has complete, secret-free evidence\n`,
  );
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

module.exports = { validateRecord };

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.exitCode = report([
      `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}
