Status: passed

Scope: pre-upgrade user attestation, recorded with v0.1.0 installed. Sign-in
on v0.1.1 has not been re-verified.

# Live sign-in certification (release gate)

- Status vocabulary: `release-blocked` or `passed`. No other value is valid for
  this gate, and it is never inferred from an adjacent test.
- Gate: an ordinary Google account completes sign-in inside the app-owned child
  flow, and that session survives a full application relaunch in the same
  per-Windows-user persistent profile as the main window.
- Certification basis: the user's personal visual observation, attested in this
  conversation, confirms live sign-in and persistence after all app processes
  exited and the app was fully relaunched. No logs or screenshots were provided.
  The user accepts visual attestation instead of the previously mandatory JSONL
  evidence. This record supersedes that telemetry requirement for this
  certification; manual attestation and the metadata below suffice.
- Evidence limits: this is not an independent observation of sign-in origins,
  the profile directory, or any phone/2FA challenge. No machine logs or
  screenshots are claimed as evidence of the sign-in or relaunch.
- Hard rule: a failed live sign-in is recorded as `release-blocked`. It is NEVER
  converted into a guest-mode pass. Guest viewing may remain a documented
  fallback, but it does not satisfy, waive, or soften this gate.

## Certification metadata

These values were captured before the v0.1.1 upgrade. This attestation does not
certify the later installation.

| Field                           | Recorded value                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Test date                       | 2026-10-01 (recorded at the user's request before the upgrade)                                     |
| Record/system capture timestamp | 2026-10-01T23:40:37+08:00 (Taipei Standard Time)                                                   |
| Exact test time                 | Not captured; the capture timestamp is not the original test time                                  |
| Windows edition and release     | Windows 11 Pro for Workstations 25H2                                                               |
| Windows version                 | 10.0.26200                                                                                         |
| Full Windows build              | 26200.9457                                                                                         |
| Architecture                    | x64/AMD64                                                                                          |
| App ProductVersion at capture   | 0.1.0.0, from executable metadata                                                                  |
| App FileVersion at capture      | 0.1.0, from executable metadata                                                                    |
| Repository version at capture   | 0.1.1; the installed app was 0.1.0 at capture                                                      |
| Electron runtime at capture     | 44.4.5, confirmed by the installed EXE with `ELECTRON_RUN_AS_NODE=1` evaluating `process.versions` |
| Sign-in evidence                | User's personal visual observation attested in this conversation                                   |
| Logs/screenshots                | None provided                                                                                      |

## Evidence required for `passed`

Manual visual attestation of both outcomes and recorded certification metadata
are sufficient. Telemetry and screenshots are optional supplemental evidence,
not mandatory for this certification.

1. Live account sign-in completes in the app, and YouTube TV shows the signed-in
   state. The procedure below describes the expected child flow; this record
   doesn't independently verify its origins or any phone challenge.
2. The session survives a FULL relaunch. After every app process has exited,
   relaunching the app opens YouTube TV already signed in. The persistence probe
   must be a full process restart, not a window reload.
3. This document records `Status: passed`, the attestation, date, installed
   application version, Windows build, and installed Electron version. Record
   an evidence directory path only if supplemental files were actually collected.

If telemetry is collected, JSONL files for both runs must be copied verbatim and
unedited and satisfy the redaction contract below (allowlisted keys only,
origins only, no secret material). A file that fails the contract invalidates
the diagnostic run and must be deleted and re-run, never hand-edited.

If item 1 or 2 fails, record the failing step, the observed (secret-free)
behavior, and keep the status `release-blocked`.

## What the diagnostic mode records (and never records)

Diagnostics are OPT-IN and OFF by default. The switch is one sentinel file
read once at startup:

```
%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\ENABLED
```

When that file is absent, the app wires no listeners at all: navigation,
user-agent, popup and security behavior are byte-identical to a non-diagnostic
build. When it exists, the app appends JSON Lines to:

```
%PROGRAMDATA%\youtubetv-for-windows\users\<key>\diagnostics\
    diagnostic-<YYYYMMDDThhmmssSSSZ>-p<pid>-<instance>.jsonl
```

`<key>` is the Windows user name taken from the basename of `%USERPROFILE%`,
sanitized to `[A-Za-z0-9._-]`; step 2 below derives it exactly. The root holding
it is the machine-wide data tree `C:\ProgramData\youtubetv-for-windows`
(`%PROGRAMDATA%\youtubetv-for-windows`), which the installer creates and ACLs at
install time; a live capture has to land in that tree on the certified machine.

The `diagnostics` directory is a sibling of the persistent `profile` directory,
both under that ProgramData tree. The uninstaller removes the whole
`%PROGRAMDATA%\youtubetv-for-windows` tree, which covers every user's
diagnostics, profile and userdata directories.

Recorded events (complete list): `app-ready`, `app-quit`, `window-created`,
`navigation-committed`, `load-finished`, `load-failed`, `auth-window-opened`,
`auth-window-closed`.

Recorded fields (complete list): `{ ts, event, origin?, errorCode?,
windowKind? }`.

- `origin` is `new URL(url).origin` — scheme + host + port only. Paths, query
  strings, fragments and credentials are stripped by construction.
- `errorCode` is the numeric Chromium load-failure code.
- `ts` always comes from the app's own clock; callers cannot supply it.
- Unknown keys are dropped and unknown events are rejected by a pure sanitizer,
  and any string that still looks like a JWT, bearer token, cookie,
  authorization header, `token=` parameter, or long base64/hex blob is dropped
  as a fail-closed second layer.

Never recorded: full URLs, URL paths, query strings, fragments, cookies,
headers, tokens, account identifiers, DOM content, or any credential.

The automated redaction contract lives in `test/diagnostics/**` (pure suite)
and `test/electron/diagnostics-telemetry.test.mjs` (real Electron run against a
fixture page that sets a cookie and navigates with secret-shaped query values).

## Procedure (maintainer, optional supplemental capture)

This procedure remains available for reproducible supplemental evidence. Steps
2, 8, 9, and 10 apply only when diagnostics or supplemental files are collected;
they aren't prerequisites for the visual-attestation certification above.

Prerequisite: a Windows desktop session that can run the app, a real ordinary
Google account (2FA phone available), and a build of this repository.

1. Build the application (development or installed release):

   ```powershell
   npm run build
   ```

   An installed release (`ps5-youtube-tv-windows` plan todo 7) works the same
   way; use its shortcut.

2. Optionally enable diagnostics:

   ```powershell
   # The app's per-Windows-user key: basename of %USERPROFILE%, sanitized to
   # [A-Za-z0-9._-] (src/main/profile-path.ts: sanitizeUserKey). The
   # parentheses matter: -replace is an operator, not a Split-Path argument.
   $key = (Split-Path -Leaf $env:USERPROFILE) -replace '[^A-Za-z0-9._-]', '_'
   $dir = Join-Path $env:ProgramData "youtubetv-for-windows\users\$key\diagnostics"
   New-Item -ItemType Directory -Force $dir | Out-Null
   New-Item -ItemType File -Force (Join-Path $dir "ENABLED") | Out-Null
   ```

3. Launch the app (`npx electron .` from the repository, or the installed
   shortcut). The window opens fullscreen on `https://www.youtube.com/tv`.

4. Sign in. Use YouTube TV's own Sign in entry point:
   - The sign-in page must open in an app-owned child window for
     `accounts.google.com` / `accounts.youtube.com`, sharing the app session.
   - Complete the account password and any phone/2FA challenge normally inside
     that child. Do NOT open DevTools, do NOT export cookies, do NOT capture
     the password or the challenge codes.
   - If the child is blocked, closed, or leaves the allowlist, stop: this is a
     failure, record it as `release-blocked` with the failing step.

5. Confirm the TV home screen shows the signed-in state.

6. Quit fully. Close the window and wait until no app process remains (Task
   Manager, or `Get-Process` with no `youtubetv`/`electron` entry). A full quit
   is required so the persistent profile is flushed to disk.

7. Relaunch, same user, same build. YouTube TV must open already signed in,
   with no sign-in prompt. This is the persistence half of the gate.

8. If enabled, disable diagnostics again, keeping the JSONL files for evidence:

   ```powershell
   Remove-Item (Join-Path $dir "ENABLED")
   ```

9. If collected, verify the JSONL files before storing them:
   - Every line must parse as JSON.
   - Every key must be one of `ts`, `event`, `origin`, `errorCode`,
     `windowKind`.
   - Every `origin` must match `^https?://[^/?#]+$` (origin only).
   - No line may contain `token`, `sapisid`, `cookie`, `bearer`,
     `authorization`, `eyJ`, `?`, or `#`.
   - `Get-Process`-style manual scan plus a `Select-String` check:

   ```powershell
   $latest = Get-ChildItem $dir -Filter "diagnostic-*.jsonl" |
     Sort-Object LastWriteTime | Select-Object -Last 1
   $allowed = @("ts", "event", "origin", "errorCode", "windowKind")
   Get-Content $latest.FullName | ForEach-Object {
     $record = $_ | ConvertFrom-Json
     foreach ($property in $record.PSObject.Properties.Name) {
       if ($allowed -notcontains $property) { throw "unexpected key: $property" }
     }
     if ($record.PSObject.Properties.Name -contains "origin") {
       if ($record.origin -notmatch '^https?://[^/?#]+$') { throw "origin not origin-only: $($record.origin)" }
     }
   }
   foreach ($marker in @("token", "sapisid", "cookie", "bearer", "authorization", "eyJ", "?", "#")) {
     if (Select-String -Path $latest.FullName -Pattern $marker -Quiet) { throw "telemetry contains $marker" }
   }
   Write-Output "JSONL redaction check PASSED"
   ```

   The same contract is enforced automatically by `npm run test:unit` and
   `npm run test:electron`; the manual block above exists so a maintainer can
   validate the live capture without running the suite.

10. If collecting supplemental files, store evidence under:

    ```
    release-evidence/signin/run-<YYYYMMDD>-<label>/
      status.md               copy of this document's leading status block
      diagnostic-run1.jsonl   sign-in run, verbatim
      diagnostic-run2.jsonl   relaunch run, verbatim
      screenshots/            signed-in home after sign-in and after relaunch
      notes.md                app version, Windows build, Electron version, date
      jsonl-check.log         output of the verification block (with exit code)
    ```

    Include only files actually collected; this layout isn't a required checklist.
    Screenshots must show only the TV surface. Do not include account menus,
    email addresses, DevTools, or network panels.

11. Update this document: either replace the leading block with
    `Status: passed` plus the attestation and metadata above, or keep
    `release-blocked` and add the failing step to the status history below.

## Status history

- 2026-09-29 — `release-blocked` (`ps5-youtube-tv-windows` plan todo 4
  execution). Reason: no real Google account, phone, or live-sign-in permission
  in the execution environment. No live sign-in was attempted; no pass is
  claimed. At that time, unblocking required the procedure above to be executed
  by the release maintainer with JSONL evidence. This historical block is
  superseded by the 2026-10-01 certification below.
- 2026-10-01: `passed` on the user's visual attestation in this conversation of
  live sign-in and persistence after all app processes exited and a full
  relaunch. The metadata above records the application installed at capture
  separately from the repository version. No logs or screenshots were provided; the user accepts
  visual attestation instead of the earlier mandatory JSONL requirement for
  this certification. Phone pairing remains a separate, uncertified gate.

## Phone pairing follow-up (separate release gate)

Same-Wi-Fi phone pairing and playback control are release-blocking
compatibility criteria for this product (`ps5-youtube-tv-windows` plan lines 92,
158, 161). Passing the sign-in gate above does NOT prove pairing. After
sign-in certification, run a dedicated pairing check: with the phone on the same
Wi-Fi network as the desktop, open YouTube on the phone, use its "Play on TV" /
remote flow, and evidence (a) the desktop appearing as a selectable device, and
(b) playback controlled from the phone. Record that evidence separately; this
document covers sign-in and relaunch persistence only.
