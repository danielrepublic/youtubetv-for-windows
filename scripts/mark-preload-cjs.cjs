"use strict";

// Writes dist/preload/package.json = {"type":"commonjs"}.
//
// The root package is "type": "module", so under Node/Electron resolution a
// bare ".js" file is ESM unless a nearer package.json says otherwise.
// tsconfig.preload.json emits the sandboxed preload as CommonJS, and this
// marker is what makes Electron actually load it as CommonJS. The step fails
// closed if the TypeScript emit is missing, so a broken preload build cannot
// silently ship.

const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const PRELOAD_OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, "dist", "preload");
const PRELOAD_ENTRY_PATH = path.join(PRELOAD_OUTPUT_DIRECTORY, "preload.js");
const MARKER_PATH = path.join(PRELOAD_OUTPUT_DIRECTORY, "package.json");
const MARKER_CONTENT = `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`;

if (!fs.existsSync(PRELOAD_ENTRY_PATH)) {
  process.stderr.write(
    "[build] FAIL expected the CommonJS preload emit at dist/preload/preload.js; " +
      "run `tsc -p tsconfig.preload.json` first\n",
  );
  process.exitCode = 1;
} else {
  fs.writeFileSync(MARKER_PATH, MARKER_CONTENT, "utf8");
  process.stdout.write(
    `[build] wrote ${path.relative(REPOSITORY_ROOT, MARKER_PATH).split(path.sep).join("/")} ` +
      '({"type":"commonjs"}) so Electron loads the sandboxed preload as CommonJS\n',
  );
}
