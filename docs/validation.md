# Validation and evidence

Use the smallest relevant focused check while developing, then run **`pnpm validate` after implementation changes**. CI runs the aggregate on Linux, macOS and Windows. Checks use synthetic local fixtures, never a contributor's live SSH state or real targets.

## Commands and ownership

| Command                                                             | Owner / evidence                                                             | Side effects and limits                                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                 | Repository formatting                                                        | Read-only; not a code-quality/security audit                                                                                  |
| `pnpm build`                                                        | Package types and canonical-source runtime bundle                            | Writes ignored `dist/` directories; includes dependency notices                                                               |
| `pnpm docs:check`                                                   | Documentation links/heading anchors, fenced JSON, YAML syntax                | Offline; includes non-ignored untracked files. Does not fetch external links, validate Actions semantics or render Mermaid    |
| `pnpm test`                                                         | Library, runtime, MCP, examples, docs-checker and artifact-verifier fixtures | Requires a build; temporary files, local ports/processes; native/browser fixtures opt in                                      |
| `pnpm pack:check`                                                   | Published-shape package inventories and offline consumer imports             | Temporary tarballs/install; requires `tar` and a populated pnpm store from normal install; no publication or live connections |
| `pnpm validate`                                                     | Formatting → build → docs → tests → package check                            | Local aggregate, not production/native-platform certification                                                                 |
| `pnpm artifact`                                                     | Clean-source export/provenance                                               | Requires clean committed source and matching build; writes ignored artifact output                                            |
| `pnpm artifact:verify <directory> <trusted-digest> [source-commit]` | Offline consumer integrity check                                             | Read-only, no candidate execution; trusted external pin required                                                              |

The package check verifies all three packages contain READMEs/licenses, advertised entrypoints and concrete internal dependency versions, excludes source/tests/private files, then installs tarballs into an isolated consumer using the source workspace's resolved pnpm store and `--offline --frozen-lockfile --ignore-scripts`, and imports the public APIs. Reusing that store also supports temporary consumers on a different Windows drive or outside workspace-local store configuration. The consumer lockfile reuses the reviewed registry graph and replaces only workspace roots with the exact local tarballs and their integrity hashes; it does not re-resolve third-party versions or depend on registry metadata being cached. Only this disposable, derived consumer uses pnpm's `--trust-lockfile` to avoid a second network-dependent policy lookup; the normal source install still enforces the repository's supply-chain policies. This is not a recommendation to bypass policy verification in a real consumer project. It does not start an SSH daemon. It is inspired by the source-to-consumer proof pattern in [Agent Skills](project-readiness.md#patterns-adapted-from-agent-skills), adapted to npm packages rather than skill installations.

## Optional native qualification

Prerequisites: existing `sshd`, `ssh-agent`, `ssh-add` and `tmux`. On Linux/macOS:

```sh
SSH_MANAGER_NATIVE_TESTS=1 SSH_MANAGER_SSHD="$(command -v sshd)" SSH_MANAGER_TMUX="$(command -v tmux)" pnpm test
```

This starts a temporary loopback OpenSSH daemon, isolated SSH agent and tmux socket with generated credentials. It verifies encrypted key-file and agent authentication, SFTP, plain-PTY loss and actual tmux recovery across manager restart. It must not reuse a developer's daemon, agent, keys, authorized_keys or tmux server.

Some host OpenSSH builds require additional system prerequisites to launch even a private daemon. Report failures rather than silently using a real service. No local prerequisites should be installed or configured without authorization. Hosted Unix CI provisions its disposable runner explicitly; Windows does not claim this Unix native qualification.

## Optional browser qualification

Prerequisites: existing agent-browser and its Chrome installation. The CI browser tooling is pinned to `agent-browser@0.38.2` and provisioned only on its disposable runner.

```sh
SSH_MANAGER_BROWSER_TESTS=1 pnpm test
```

The fixture uses its own named session, temporary state, tokens and local SSH fixture. It checks typing/paste after writer-lease expiry, exclusive writer ownership, detach/reattach without duplicate output and memory-only tokens. It cleans up its own resources. It is not full browser, accessibility or mobile qualification.

Mermaid diagrams must also be inspected in a GitHub-compatible renderer when changed. Keep a prose description next to each diagram. `docs:check` explicitly does not claim to render them.

## Negative and boundary coverage

Existing fixtures cover host verification, grants, credential/vault failure cases, state migration/ownership, jobs, PTY loss/recovery, file roots, tunnels, API authentication/origins and MCP setup exclusions. Architecture tests guard package dependency direction and deterministic bundled source ownership.

Synthetic direct-management tests use a managed SSH fixture lifetime for failure-safe acquisition and ordered release. Lifecycle fixtures cover constructor/vault/trust/grant setup failure, registration and listen failure, partial cleanup failure, repeated release and tracking a replacement manager. Cleanup attempts remaining owned resources before reporting aggregated failures; repeated release observes the same outcome rather than silently retrying. Native and runtime/browser resources retain separate ownership.

Operation-result fixtures check catalog/schema coverage, preserved nullable and optional wire meanings, shared parser/client behavior, malformed envelopes and result fields, sanitized errors and no operation replay. Compile-only fixtures verify schema-derived client results for every operation and reject incompatible synchronous/asynchronous handler results. Existing runtime/MCP fixtures continue to check authenticated roles, writer identity and discovery; these checks are not live target qualification.

New consumer-verifier fixtures reject missing pins, wrong revisions, missing/extra/modified files, unexpected directories, unsafe/duplicate/unsorted paths, invalid metadata and symlinks. Documentation-checker fixtures cover missing targets/anchors, traversal, invalid JSON and duplicate YAML keys. First-connection JSON examples are validated against the actual operation schemas; the typed-client example runs against an isolated runtime.

## Reporting results

Record the source/candidate being checked, commands, pass/fail/skip/not-run status and limitations. A successful local test is not evidence of a hosted CI run, public release, registry install, live upgrade or production behavior. A skipped native fixture is not a platform pass. If a check fails, fix the owning contract and rerun it plus the aggregate; do not remove the check just to make the summary green.

CodeQL and scheduled dependency update configuration live under `.github/`. Enabling GitHub features, branch protection and required checks is a separate administrator action; see [maintainer follow-ups](project-readiness.md#maintainer-actions-outside-this-change).
