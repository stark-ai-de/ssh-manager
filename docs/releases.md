# Distribution and release preparation

The supported starting point is a source checkout. The project also builds a standalone runtime bundle and local package tarballs. **Building or checking either format does not publish a GitHub Release or npm package.** No automatic publishing workflow is installed.

## Choose a distribution

| Audience                | Format                                | Requirements                                                        |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Contributor             | Source checkout                       | Git, Node 24.18.0+, pnpm 12.9.1                                     |
| CLI/viewer/MCP end user | Reviewed standalone `runtime/` bundle | Node 24.18.0+; all adjacent bundle assets retained                  |
| TypeScript application  | Library/runtime package tarballs      | Compatible Node and dependency installation in the consumer project |

Do not advertise `npm install @stark-ai/ssh-manager` as a proven public path until publication is authorized and the published bytes/install are checked. See [library usage](library.md) for local tarballs. Package versions remain `1.0.0`; maturity/support is [early-stage](compatibility.md).

## Prepare a runtime candidate

From a **clean, committed, reviewed** checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm validate
pnpm artifact
```

Export writes `dist/artifact/runtime` and rejects dirty/uncommitted source or stale build inputs. Do not commit merely to bypass this guard, clean someone else's changes, or label an uncommitted candidate as the original `HEAD`. The producer commit in the manifest must be the exact source revision used.

The qualification workflow uploads per-OS candidate bundles and records their source commit and manifest digest in its summary. PR artifacts are test candidates, not endorsed public releases. Check the workflow identity, revision and successful required jobs; a downloadable artifact alone proves none of those. Workflows added in a PR are not considered run until hosted evidence exists.

## Verify a runtime bundle

Use the verifier from a **trusted source checkout**. It needs only Node built-ins, not installed workspace dependencies. Place the candidate in a private directory; avoid shared writable staging locations. Do not execute anything from an unverified download.

Obtain the expected manifest SHA-256 and full source revision from an independently trusted maintainer review/release record, then substitute the values below:

```sh
node scripts/ssh/verify-artifact.mjs /ABSOLUTE/PATH/runtime TRUSTED_MANIFEST_SHA256 EXPECTED_FULL_SOURCE_COMMIT
```

Success prints the version, producer revision, manifest digest and file count. Failure exits nonzero without running candidate code. It checks the [format-1 artifact contract](artifact-contract.md), including complete inventory, required files, sizes/hashes, safe paths, build metadata and rejection of extra files/directories, symlinks and special files.

To **record** the digest of your own reviewed candidate:

```sh
node -e 'const fs=require("node:fs"),c=require("node:crypto"); console.log(c.createHash("sha256").update(fs.readFileSync("dist/artifact/runtime/ARTIFACT-MANIFEST.json")).digest("hex"))'
```

Computing a digest from an untrusted download and passing that same digest to the verifier only checks self-consistency; it does not authenticate the publisher. Keep the separately reviewed digest/commit with your installation record. Verify the final destination after copying, and keep it immutable while running.

Only after verification:

```sh
node /ABSOLUTE/PATH/runtime/cli.mjs help
```

Use [getting started](getting-started.md) for human setup, changing the CLI path to the bundle entrypoint. No dependency installation or source rebuild happens at normal MCP startup.

## Maintainer publication checklist

Publication still requires explicit approval of the exact version, source revision, destination and artifact digest.

- [ ] Review [readiness](project-readiness.md) and unresolved security/contact/settings work.
- [ ] Update changelog/version metadata intentionally; keep the three workspace packages and root release version consistent for this coupled distribution.
- [ ] Preserve previous release notes; don't invent a historical release for an unpublished package version.
- [ ] Run `pnpm validate`; run relevant native/browser qualification and record skips honestly.
- [ ] Obtain hosted qualification on the exact intended source revision. Review CodeQL/dependency findings rather than equating a scanner with an audit.
- [ ] Export only from clean committed source, verify full inventory and retain license notices/provenance.
- [ ] Record Node/platform compatibility, upgrade/backup/rollback limits and any breaking changes.
- [ ] For npm publication, separately verify scope ownership/authentication, tarball contents, dependency versions and a clean consumer install. Use trusted publishing/provenance where the chosen registry supports it; do not put a long-lived token in source.
- [ ] For a GitHub Release, separately authorize tag/release creation and upload the reviewed bytes plus their manifest identity. Do not replace already released bytes silently.
- [ ] After publication, download and verify the public payload against the approved digest and run a safe consumer smoke check. Record actual URLs/results, not merely the upload success.

Artifact rollback means deliberately selecting a prior verified installation; it does not reverse remote commands or guarantee state downgrade compatibility. Follow [operations](operations.md#upgrade-and-roll-back). No release, tag, registry publication, external plugin import or live installation switch is performed by `pnpm validate`, `pack:check` or `artifact:verify`.
