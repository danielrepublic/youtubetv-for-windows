# Release signing runbook

This runbook provisions the Ed25519 key material used by the protected GitHub
Release workflow. It is intentionally a maintainer operation, not a CI step.

## Non-negotiable custody rules

- The private key must never be committed, printed, pasted into a terminal
  transcript, or logged.
- Generate keys outside the repository in a trusted, access-controlled location.
- Only the private key is stored as a GitHub secret. Public keys belong in the
  launcher keyring.
- The current `REPLACE_BEFORE_RELEASE` values in
  `src/main/update/keyring.ts` are deliberate release blockers. Do not create a
  stable release until they have been replaced and the resulting launcher is
  shipped.

## Generate current and next keys

Run the following once for the current key and once for the next key from a
trusted directory outside this repository. Replace the final argument with a
different private-file path for each key. The command writes files only; it
does not print private material.

```powershell
node -e "const c=require('node:crypto'),f=require('node:fs'),p=require('node:path');const o=process.argv[1];const k=c.generateKeyPairSync('ed25519');f.writeFileSync(o,k.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});f.writeFileSync(o+'.spki.b64',k.publicKey.export({format:'der',type:'spki'}).toString('base64')+'\n',{mode:0o600});" "C:\trusted-release-keys\ytvw-release-primary.pem"
```

Keep each `.pem` private file in the approved secret store. The adjacent
`.spki.b64` file is public-key material only; it is the value embedded in the
launcher. Do not put either generated file under the repository directory.

## Embed and ship the public keyring

1. Set `ytvw-release-primary` to `status: "active"` with the current key's
   SPKI base64 value in `src/main/update/keyring.ts`.
2. Set `ytvw-release-next` to `status: "next"` with the next key's SPKI base64
   value.
3. Review that no `REPLACE_BEFORE_RELEASE` marker remains, run the updater
   verification suite, and ship that launcher before signing releases it must
   trust.
4. The workflow's `--verify` phase uses the app's real `PRODUCTION_KEYRING`.
   It must fail while placeholders remain, which prevents a false trusted
   release.

The app accepts signatures from both `active` and `next` keys. For rotation,
ship a launcher that already contains the replacement `next` public key, then
promote it to `active`, update the workflow's `--key-id` to the promoted key ID,
add a new `next` public key, and replace the protected secret with the newly
active private key. Never revoke an old public key before the replacement key
is present in a launcher users can install.

The workflow signs with `--min-bootstrap-version 0.1.0 --min-app-version 0.1.0`.
Those are the oldest launcher versions that implement this update contract, not
the current release version; do not raise them without a corresponding
minimum-supported-version decision.

## Configure the protected GitHub environment

1. In GitHub, open **Settings** > **Environments** > **New environment** and
   create `release`.
2. Require reviewer approval and restrict deployment targets to protected
   stable version tags matching `v*.*.*`. Configure tag protection for the
   same pattern so only authorized maintainers can create a release tag.
3. Under the environment's **Secrets**, add exactly one secret:
   `RELEASE_ED25519_PRIVATE_KEY`. Paste the current active private PEM through
   GitHub's UI. Do not add this secret at repository or organization scope.
4. Do not add a public-key secret, token, certificate, or a second private key.
   The workflow uses the job-scoped `GITHUB_TOKEN` with `contents: write` only
   to create the release after approval.

Only the manifest-signing step receives `RELEASE_ED25519_PRIVATE_KEY`. The
step that re-verifies the staged assets immediately before upload is
deliberately secret-free: `--verify-only` reads only public keyring material.

The workflow triggers only on pushed `v*.*.*` tags and rechecks the tag is a
stable SemVer matching `package.json`. It has no pull-request trigger. The
only step that receives `RELEASE_ED25519_PRIVATE_KEY` is the manifest-signing
step inside the `release` environment job.

## Release operation

1. Complete the release certification gate and create the protected tag
   `v<package.json version>`.
2. Approve the `release` environment deployment in GitHub.
3. The workflow installs, type-checks, unit-tests, lints, format-checks,
   packages, verifies the x64 artifact, copies the exact installer into a
   four-file release asset directory, signs its canonical manifest, and verifies
   the manifest, signature, checksum, and installer through the app code.
4. Before publication, it re-verifies the staged directory with
   `--verify-only`: the same application pipeline, no signing, no secret. Any
   byte altered after signing makes this gate fail and the release is not
   created.
5. It refuses to overwrite an existing GitHub Release for the tag, then uploads
   exactly the installer, `update-manifest.json`, `update-manifest.sig`, and
   `update-manifest.sha256` with bilingual release notes.

The protected workflow has not been run by local verification. Local proof is
limited to the dependency-free generator's non-production-key dry run, the
scratch-tree `--verify-only` proof, and the CI policy tests.
