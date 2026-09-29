# Developer bootstrap

This document is the reproducible command contract for the `youtubetv-for-windows`
workspace. It is intentionally specific: every command below is expected to run
exactly as written on a Windows x64 machine.

## Supported platform and toolchain

The workspace is **Windows x64 only** (`os: ["win32"]`, `cpu: ["x64"]` in
`package.json`). There is no x86, ARM64, Linux, or macOS path; do not add one.

| Component                               | Supported range (`engines`) | Exact pin used by this revision |
| --------------------------------------- | --------------------------- | ------------------------------- |
| Node.js                                 | `>=24.19.0 <25.0.0`         | 24.19.0                         |
| npm                                     | `>=11.17.0 <12.0.0`         | 11.17.0 (also `packageManager`) |
| Electron                                | —                           | 44.4.5                          |
| electron-builder                        | —                           | 26.15.3                         |
| TypeScript                              | —                           | 5.9.3                           |
| ESLint / @eslint/js / typescript-eslint | —                           | 10.11.0 / 10.0.1 / 8.70.1       |
| Prettier                                | —                           | 3.9.9                           |
| globals                                 | —                           | 17.12.0                         |
| @types/node                             | —                           | 24.19.0                         |

Ranges exist because a routine Node.js or npm **patch or minor** release must not
brick the install; reproducibility of the dependency graph comes from the
committed `package-lock.json` and the `packageManager` field, not from an exact
toolchain pin. The exact runtime used for this revision's evidence is recorded
per command under `release-evidence/`.

## Commands

| Command                                   | What it does                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run preflight`                       | Fail-closed toolchain check: Node.js, npm, platform, and architecture against `package.json`.                                                                                |
| `npm run clean`                           | Removes `dist/` and `release-output/`.                                                                                                                                       |
| `npm run clean-install`                   | `npm run clean && npm run preflight && npm ci` — the reproducible cold install.                                                                                              |
| `npm run build`                           | Emits the ESM main tree (`dist/main/`), the CommonJS preload (`dist/preload/`), and the CJS marker.                                                                          |
| `npm run lint`                            | ESLint flat config over the repository.                                                                                                                                      |
| `npm run format` / `npm run format:check` | Prettier write / verify.                                                                                                                                                     |
| `npm run typecheck`                       | `tsc --noEmit` for both the main and the preload configs.                                                                                                                    |
| `npm test` / `npm run test:unit`          | Headless unit chain (`test/**/*.test.mjs` outside `test/electron/`).                                                                                                         |
| `npm run test:electron`                   | Desktop chain (`test/electron/**/*.test.mjs`), needs the installed Electron binary.                                                                                          |
| `npm run package`                         | `npm run build` then `electron-builder --win --x64 --publish never`, producing `release-output/youtubetv-for-windows-<version>-x64.exe` plus `release-output/win-unpacked/`. |
| `npm run verify:artifacts`                | Verifies the versioned x64 installer and exactly one Windows x64 application executable (see below).                                                                         |
| `npm run verify:static`                   | `preflight` + `lint` + `format:check` + `typecheck` + `test:unit`.                                                                                                           |
| `npm run verify:windows`                  | `test:electron` + `package` + `verify:artifacts`.                                                                                                                            |
| `npm run verify`                          | `verify:static` then `verify:windows`.                                                                                                                                       |

### Why `verify:static` and `verify:windows` are split

Electron window/keyboard behavior cannot be asserted headlessly. The plan
requires the Electron integration tests to run only on a pinned Windows runner
or a desktop-session VM. `verify:static` is safe anywhere Node.js runs;
`verify:windows` is the desktop-session contract and is the only chain that
touches `npm run package`. A green `verify:static` must never be read as
"the Electron host works".

## Clean install and the toolchain gate

`npm run clean-install` is the supported cold-start path:

1. `npm run clean` deletes `dist/` and `release-output/`.
2. `npm run preflight` runs `scripts/check-environment.cjs`, which fails closed
   on a wrong Node.js/npm/platform/architecture **before any dependency is
   reified**.
3. `npm ci` reifies exactly the lockfile and then runs the root `postinstall`.

The division of labor between the two gates is deliberate and was measured:

- `.npmrc` sets `engine-strict=true`. That is **npm's own gate**: `npm ci`
  aborts before reification when the running Node.js/npm does not satisfy the
  `engines` ranges.
- `package.json` also wires `preinstall` to `scripts/check-environment.cjs`.
  On npm 11 the root lifecycle scripts run **after** reification, so the
  `preinstall` hook is a message for the operator, **not** an ordering gate.
  That is why `clean-install` additionally runs `npm run preflight` as its
  first step, and why the failure message says exactly
  `Installation is blocked.` rather than claiming the failure happened
  "before dependencies are installed".

## The load-bearing `postinstall`

`electron@44.4.5` declares **no `scripts` field at all**, so it has no install
hook of its own. Without the root hook

```
"postinstall": "node node_modules/electron/install.js"
```

`npm ci` installs the Electron JavaScript package and **no binary**, and every
downstream test fails later with a confusing error. The hook downloads (from
the content-addressed Electron cache when present) and extracts the binary; a
`%LOCALAPPDATA%\electron\Cache` entry makes installs fast and offline.

After any install, assert all three of these, not just the package version:

- `node_modules/electron/path.txt` exists,
- `node_modules/electron/dist/` exists,
- `node_modules/electron/dist/<path.txt contents>` runs (`--version`).

Never import the `electron` package from a test: `index.js` calls
`getElectronPath()` at require time and downloads ~150 MB when `path.txt` is
missing. `test/electron/electron-version.test.mjs` checks `path.txt` first with
an actionable message and spawns the binary instead.

## `allowScripts`

`package.json` declares `"allowScripts": { "electron-winstaller": true }`. This
is npm's project-level install-script allowlist (RFC npm/rfcs#868): it is an
allowlist, so an empty object denies every dependency install script. The entry
is bound by an equality assertion in
`test/preflight/workspace-policy.test.mjs` to the exact set of lockfile
packages that declare `hasInstallScript`, so a new dependency with an install
script (or a stale entry) fails the build instead of silently not being built.
The root project's own `preinstall`/`postinstall` always run regardless.

## ESM main plus CommonJS preload

The root package is `"type": "module"`. The plan mandates `sandbox: true` for
the renderer, and a sandboxed Electron preload **cannot be ESM**. The build
therefore has two emitters:

- `tsconfig.build.json` → `dist/main/index.js` (ESM, NodeNext, `package.json`
  `main`).
- `tsconfig.preload.json` → `dist/preload/preload.js` (CommonJS).
- `scripts/mark-preload-cjs.cjs` writes `dist/preload/package.json` with
  `{"type":"commonjs"}`, because the nearest `package.json` is what decides how
  a bare `.js` file is resolved under the root `"type": "module"`. The marker
  step fails if the TypeScript emit is missing, and
  `test/preflight/workspace-policy.test.mjs` pins the whole invariant.

Do not "simplify" the preload to a single ESM config; todo 2's preload would
then fail to load while every other test still passed.

Local TypeScript imports use explicit `.ts` specifiers (e.g.
`import { x } from "./foo.ts"`); unit tests may import `src/**/*.ts` directly
because Node 24 type-strips TS, emit rewrites specifiers to `.js` via
`rewriteRelativeImportExtensions`, and TS sources must stay
erasable-syntax-only (no `enum`, no `namespace`, no parameter properties)
because type stripping cannot transform those.

## Artifact verification (`verify:artifacts`)

`scripts/verify-artifacts.cjs` is fail-closed and derives everything it reports
from the produced files:

- the top-level directory set of `release-output/` must equal exactly
  `{win-unpacked}` — an exact-set assertion, never a denylist of guessed names,
  because electron-builder also emits `win-ia32-unpacked`,
  `win-arm64-unpacked`, and `linux-*`/`mac*` siblings;
- all recursive `.exe` files under `release-output/` must reduce to exactly
  the versioned top-level installer plus the one expected application
  executable (`win-unpacked/<productName>.exe`) — an `elevate.exe` helper or
  any stray binary fails;
- exactly one top-level installer must exist and its name must equal the
  versioned convention `<productName>-<version>-x64.exe`, which is also what
  the configured `build.nsis.artifactName` template must render to. The only
  other permitted top-level files are electron-builder's pinned byproducts
  (`<installer>.exe.blockmap`, `latest.yml`, `builder-debug.yml`,
  `builder-effective-config.yaml`); anything else fails closed by name;
- the PE header is parsed for real: `e_lfanew` at `0x3C`, `PE\0\0` signature,
  `Machine == 0x8664` (AMD64), `OptionalHeader.Magic == 0x20b` (PE32+), and a
  Windows GUI/console subsystem. The reported `architecture`/`platform` come
  from those reads, never from string literals;
- every path segment (file **and** directory) is checked for `webview2` /
  `edgewebview`;
- signing material (`.pfx .p12 .pvk .cer .spc`) and archive/installer formats
  (`.zip .7z .msi .msix .msixbundle .appx .appxbundle`) are rejected by
  extension.

`npm run package` builds the full per-user x64 NSIS installer (assisted UI,
per-user install root without UAC, Start-menu shortcut, committed
`build/nsis.include`, and the profile-removing uninstaller). The installer stub
itself is name/count-checked only — NSIS stubs are not x64 images, so the PE
arch guard applies to the application executable.

## Evidence

Every QA run is sealed under `release-evidence/bootstrap/run-<id>/` (gitignored).
Each log contains the exact command line, resolved Node.js/npm/platform
versions, the full raw stdout+stderr, elapsed time, and a
`FINAL EXITCODE: <n>` footer. A log without that footer is not evidence.

Generated directories (`dist/`, `release-output/`, `release-evidence/`,
`node_modules/`) are gitignored; the only committed artifact is the single root
`package-lock.json`.

`.gitattributes` pins `* text=auto eol=lf` so a fresh `git clone` on a Windows
machine with `core.autocrlf=true` still checks out LF working-tree files.
Without it, `npm run format:check` fails in every clone while passing in the
authoring workspace — the formatter gate must be clone-stable.

## Electron upgrade policy

1. Pick a stable Electron release on a supported major line and update the
   exact `devDependencies.electron` pin.
2. Run `npm run clean-install` so the new binary is fetched and extracted.
3. Run `npm run test:electron`. The test suite compares the **real binary's**
   `electron --version` output to the pin; there is deliberately no
   hardcoded "supported major" magic number to rot.
4. Run `npm run package && npm run verify:artifacts` to confirm the new binary
   still produces exactly one Windows x64 PE32+ executable.
5. Re-run the live release-certification gates (sign-in persistence, phone
   control, actual 2160p) before publishing; an Electron upgrade invalidates
   prior certification evidence.

`electron@44.4.5` is the current pin. The documented upgrade check is the
binary equality test in `npm run test:electron`, not a prose promise.
