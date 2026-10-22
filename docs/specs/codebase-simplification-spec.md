---
title: Complete behavior-preserving code simplification
status: implemented-and-validated
---

# Codebase simplification

The initial C01–C08 inventory and evidence are retained below. The final performance follow-up has a separate baseline, validation and accounting record at the end.

## Approved scope and baseline

Apply [ADR-0001](../adrs/0001-behavior-preserving-code-simplification.md) to all handwritten code in the three packages, viewer, examples, scripts and tests. Preserve public APIs, CLI/MCP/HTTP behavior, stored data and security/lifecycle contracts. No dependency addition, package extraction, migration, publication or live SSH change is included.

Baseline: `ba2d3ff4f2f16aa85ada94b3a6cbcae4d87ac599`, with pre-existing changes to the three package manifests and `pnpm-lock.yaml`. Those four files remain byte-identical to their initial worktree contents and are excluded from attributable savings. The inventory contains 111 tracked/non-ignored paths, including 60 code files: 29 production files (6,058 physical lines), 18 tests/fixtures (3,570), two examples (44) and 11 scripts (918), totaling 10,590. A private content snapshot records each initial worktree file, physical line count and SHA-256 independently of HEAD; no index changes are needed for accounting. Its manifest SHA-256 is `5b9bf571b0e43900710e0b2215ec33580c7eb7cb7cfb69ae58d3ba46d002cdd1`.

Excluded from handwritten-code review: ignored dependency/build/coverage output, generated declarations/bundles, local agent tooling, runtime state and secrets. Repository documents, manifests and workflows are checked for their owning contracts. CodeGraph has no index for this repository; review uses source, imports, public exports and consumer tests rather than claiming semantic coverage from text search.

## Decisions and evidence

The local decision is Accepted by the approved implementation scope. Architecture Compass supplied the inventory, simplification loop and boundary tests; its guide is not independently normative here. Agent Skills remains a reference repository. No source, skill, dependency, package boundary or policy in that repository was changed.

| ID  | Decision | Owner, removed responsibility and preservation evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | Apply    | `ssh-manager/src/util.ts` owns the common authorized resource-list filter and snapshot projection for connections, sessions, jobs and tunnels. Each service retains its own authorization callback. The two filtering phases, iteration order, omission of denied entries and shallow copies remain. A characterization test passed against the original implementation before extraction and now covers three resource services, target selection, revoked grants, caller mutations and closed managers. Existing tests cover connection filtering and invalidation. |
| C02 | Apply    | Jobs, sessions and file transfers reuse the existing `JobOptions`, `GroupResult`, `SessionOptions` and `TransferOptions` declarations in `public-api.ts`. These are type-only dependencies with identical optional properties; public facade signatures and runtime dependency direction remain unchanged. Build, declaration-graph and package-consumer checks own the proof.                                                                                                                                                                                        |
| C03 | Apply    | `ConnectionPool.capacity` owns transport and per-target saturation calculations shared by acquisition and host inspection. Acquisition still reuses connections, evicts idle entries and waits; inspection still fails immediately when full. Pending attempts, cancellation and late authentication checks remain in their original lifetimes. The inspection-under-saturation assertion passed before this extraction; fault, wait, jump-route and native fixtures pass afterwards.                                                                                 |
| C04 | Apply    | CLI command branches produce a result for one JSON output path. Operator commands retain indentation; vault/stop commands retain compact output. Prompt labels, prompt order, TTY checks, validation, error handling and client detachment remain. The existing daemon fixture now checks start/reuse, compact vault-lock output, formatted operator output and all three non-interactive vault-prompt rejections; it passed against the old bundle before rebuilding.                                                                                                |
| C05 | Apply    | Runtime download/upload endpoints share their identical private strict `fileQuery`; OpenAPI parameter names derive from that same shape. String acceptance, unknown-field rejection, parameter order and stream-specific cancellation remain. Runtime API/stream fixtures validate the consumers.                                                                                                                                                                                                                                                                     |
| C06 | Apply    | `assertLoopback` constructs its sanitized `INVALID_ENDPOINT` failure in one place. URL parsing, accepted origins and rejected credentials/query/fragment remain unchanged. Existing endpoint/error and runtime-launcher consumers are checked.                                                                                                                                                                                                                                                                                                                        |
| C07 | Apply    | Viewer socket loss and page hiding share their synchronous disconnected-state update. Poll cleanup and socket closure remain with page hiding; detach keeps its separate token/client/queue cleanup. Generation checks, writer identity, focus handling and input ordering remain. The real browser fixture passes with lease expiry, typing/paste, competing writer and reattachment without duplicate output.                                                                                                                                                       |
| C08 | Apply    | The existing SSH fixture owns the profile-input projection previously repeated in management and recovery tests. Both consumers use it; assertions and failure cases remain. CLI process collection uses Node's existing `execFile`/`promisify` and rejection matching, removing bespoke output/exit plumbing while adding contract coverage.                                                                                                                                                                                                                         |
| R01 | Retain   | `CredentialRef` remains its explicit public union. A trial schema-derived alias failed bidirectional assignment with `exactOptionalPropertyTypes: true`: Zod's optional `passphraseId` also accepts explicit `undefined`. The trial was reverted; both compiler modes pass with the retained type. Reconsider only with an equivalent derivation or separately approved public-type change.                                                                                                                                                                           |
| R02 | Retain   | SFTP list/stat/mutation scopes close on completion; returned download streams close after their pipeline, while uploads await completion and sanitize errors. A generic wrapper would need additional types/callbacks and would not simplify these distinct ownership rules. Existing bounded buffering is already local and small; no stream-consumer rewrite is needed. Reopen only when an additional consumer yields a simpler equivalent scope with cancellation/late-callback proof.                                                                            |
| R03 | Retain   | Jobs, terminals, tunnels and pending authentication have distinct state machines, retry rules, leases and disposal behavior. Keep no-job-replay, truthful PTY loss, explicit tmux recovery and vault-lock semantics. Shared budget arithmetic does not merge those lifetimes.                                                                                                                                                                                                                                                                                         |
| R04 | Retain   | `public-api.ts`, runtime catalog/handlers/output schemas, client decoding and MCP adaptation protect supported boundaries. In particular, canonical job `exitCode` and nullable wire `exitCode` differ. Keep shared operation-result validation already owned by `outputs.ts`; no generic dispatch or direct MCP SSH engine.                                                                                                                                                                                                                                          |
| R05 | Retain   | Similar input/state schemas are not all equivalent: credential-add wire strings allow empty values before domain validation, credential-update uses the core schema, and persisted terminal dimensions are separately constrained. Reusing a stricter schema would change acceptance or error ownership. Early operator checks before large bodies and later operation checks remain.                                                                                                                                                                                 |
| R06 | Retain   | Manager/vault facades enforce operator authority, audit ordering, revision/grant invalidation, key erasure and synchronous versus asynchronous behavior. Credential metadata remains an explicit allowlist. Generic CRUD/vault wrappers or spreading private metadata would obscure these contracts.                                                                                                                                                                                                                                                                  |
| R07 | Retain   | Build inventory, offline package projection and artifact verification already have separate owners. Repeated short package/hash/path expressions do not justify a cross-script utility layer. The verifier remains dependency-free and independent of producer writes; allowlists, provenance checks and export rollback are retained. Reopen only for a demonstrated repeated semantic derivation within a compatible owner.                                                                                                                                         |
| R08 | Retain   | Synthetic, native, runtime, MCP, browser and artifact fixtures have different setup/cleanup and independence obligations. In particular, synchronous configured-manager close, cached asynchronous cleanup failures and independent producer expectations remain. No assertions, negative cases or qualification gates were removed.                                                                                                                                                                                                                                  |

There are no deferred implementation candidates. Retained candidates include concrete reasons and conditions for reconsideration; they are not counted as reductions.

## Complete file coverage

All 60 handwritten code files were read semantically, including unchanged files, their ownership, consumers and relevant failure paths. The final pass revisited the complete inventory and affected consumers after C01–C08. Text/import searches aided navigation and dependency checking; they are not the coverage claim. Each row below is a file, with paths relative to the stated directory.

### Canonical library: `packages/ssh-manager/src/` (16 files)

| File             | Outcome                      | Reviewed responsibility                                                                                                  |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `connections.ts` | C01, C03; retain R03         | Route/trust/credential cache keys, transport budgets, authentication, pending cancellation, channel leases and disposal. |
| `contracts.ts`   | Retain R01, R04              | Public types, defaults, strict schemas, error codes and exact optional fields.                                           |
| `credentials.ts` | Retain R06                   | Agent/key-file/vault resolution and passphrase isolation.                                                                |
| `files.ts`       | C02; retain R02              | Path/root checks, metadata, finite SFTP scopes, streaming limits, cancellation and backpressure.                         |
| `index.ts`       | Retain R04                   | Public exports; no adapter import or additional export path.                                                             |
| `jobs.ts`        | C01, C02; retain R03         | Command encoding, bounded starts, ordered group results, cancellation and unknown outcomes without replay.               |
| `manager.ts`     | Retain R06                   | State ownership, authorization, revision invalidation, audit, secret-free metadata and supported facades.                |
| `proxy.ts`       | Retain R03                   | Bounded HTTP/SOCKS negotiation, buffered socket handoff and distinct error cleanup.                                      |
| `public-api.ts`  | Retain R04; consumed by C02  | Stable adapter-independent facade and option/result types.                                                               |
| `sessions.ts`    | C01, C02; retain R03         | PTY/tmux recovery, serialized snapshots/output, readers, writer leases, dimensions and recording.                        |
| `ssh-config.ts`  | Retain R05                   | Restricted text import, unsupported directives/warnings; no command/include execution.                                   |
| `state.ts`       | Retain R05, R06              | Persisted validation, cloned state changes, migration rollback bytes and bounded metadata audit.                         |
| `trust.ts`       | Retain R06                   | Hashed/pattern known-host matching, revocation, fingerprints and no automatic trust.                                     |
| `tunnels.ts`     | C01; retain R03              | Local/remote/SOCKS setup, channel reservation, generation checks, listeners and bounded reconnect.                       |
| `util.ts`        | C01; retain existing helpers | Atomic writes, request deadlines/late disposal, bounded decoded output and sanitized errors.                             |
| `vault.ts`       | Retain R06                   | Authenticated encryption, exclusive mutations, epochs/key zeroization, backup/restore and lock.                          |

### Runtime and viewer: `packages/ssh-manager-runtime/` (11 files)

| File                | Outcome              | Reviewed responsibility                                                                                                   |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/catalog.ts`    | Retain R04, R05      | Finite operation inventory, annotations, setup exclusions and distinct wire inputs.                                       |
| `src/cli.ts`        | C04                  | Interactive local setup, JSON-file arguments, command output and close/error ordering.                                    |
| `src/client.ts`     | C06; retain R04      | Loopback validation, registration/heartbeat, result validation, transfer progress and non-replay errors.                  |
| `src/daemon.ts`     | Retain R03, R07      | Private runtime lifecycle, bundled/source asset selection, ownership and graceful stop.                                   |
| `src/handlers.ts`   | Retain R04           | Typed wire-to-domain translation, request cancellation and result compatibility.                                          |
| `src/launcher.ts`   | Retain R03, R04      | Native platform state paths, authenticated discovery, startup ownership and readiness.                                    |
| `src/outputs.ts`    | Retain R04           | Single operation-result owner; strict envelopes, nullable/optional wire meanings and sanitized validation.                |
| `src/server.ts`     | C05; retain R04, R05 | Bootstrap/authenticated identities, origin checks, early setup authorization, HTTP streams and WebSocket writer ordering. |
| `viewer/index.html` | Retain               | Local token/session form, accessible controls and local script/style references.                                          |
| `viewer/viewer.css` | Retain               | Small local layout with existing grouped selectors; no repeated design abstraction needed.                                |
| `viewer/viewer.js`  | C07                  | Memory-only tokens, generations, writer renewal, ordered input, snapshots, focus and disconnect.                          |

### MCP: `packages/ssh-manager-mcp/src/` (2 files)

| File        | Outcome    | Reviewed responsibility                                                                            |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `main.ts`   | Retain R04 | Stdio lifecycle, authenticated local client, signals/EOF and no startup installation.              |
| `server.ts` | Retain R04 | Catalog-derived individual tools, operator exclusions, annotations and validated result envelopes. |

### Tests and fixtures (18 files)

| File                                                  | Outcome         | Reviewed proof/ownership                                                                                            |
| ----------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/ssh-manager/test/architecture.test.mjs`     | Retain R08      | Independent dependency/declaration graph and canonical-source reproducible bundles.                                 |
| `packages/ssh-manager/test/faults.test.mjs`           | Retain R08      | Denied channels, auth lock/cancellation, transfer budgets, symlinks and tunnel slots.                               |
| `packages/ssh-manager/test/fixture-lifetime.test.mjs` | Retain R08      | Failure-safe acquisition, cleanup aggregation, repeated release and replacement manager ownership.                  |
| `packages/ssh-manager/test/fixture.mjs`               | C08; retain R08 | Synthetic SSH/SFTP/proxy counterpart and explicit synchronous/asynchronous resource lifetimes.                      |
| `packages/ssh-manager/test/management.test.mjs`       | C01 proof, C08  | Trust/grants, ordered authorized snapshots, vault, jobs, terminal writer, files, tunnels and deadlines.             |
| `packages/ssh-manager/test/native.test.mjs`           | Retain R08      | Isolated real OpenSSH/agent, encrypted keys, SFTP and actual tmux survival/recovery.                                |
| `packages/ssh-manager/test/recovery.test.mjs`         | C03 proof, C08  | Trust changes, full inspection budget, pool waits, lost/recoverable sessions, jumps and proxies.                    |
| `packages/ssh-manager/test/state.test.mjs`            | Retain R08      | Migration/rollback, corrupt dimensions, concurrent owners and credential revision invalidation.                     |
| `packages/ssh-manager-runtime/test/api.test.mjs`      | Retain R08      | Early large-body authorization, roles/origins/strict inputs, HTTP transfers and WebSocket identity.                 |
| `packages/ssh-manager-runtime/test/daemon.test.mjs`   | C04 proof, C08  | Independent daemon, MCP EOF, CLI reuse/output/prompt rejection and preserved live fixture PTY.                      |
| `packages/ssh-manager-runtime/test/examples.test.mjs` | Retain R08      | Documented schemas and isolated typed-client lifecycle.                                                             |
| `packages/ssh-manager-runtime/test/results.test.mjs`  | Retain R08      | All output schemas, nullability, sanitized failures, no replay and incompatible-handler type rejection.             |
| `packages/ssh-manager-runtime/test/viewer.test.mjs`   | Retain R08      | Real browser focus/lease expiry, typing/paste, competing writer, reattach and token storage.                        |
| `packages/ssh-manager-mcp/test/protocol.test.mjs`     | Retain R08      | Legacy/current discovery, independent tool envelopes, privilege denial and EOF lifecycle.                           |
| `scripts/test/artifact-production.test.mjs`           | Retain R08      | Independent payload expectation, non-execution, staging rollback, clean-source provenance and failure preservation. |
| `scripts/test/artifact.test.mjs`                      | Retain R08      | Trusted pin, revision, tampered inventory/payload, limits, paths and symlinks.                                      |
| `scripts/test/consumer-lockfile.test.mjs`             | Retain R08      | Exact registry graph/integrities and rejection of dependency/peer drift.                                            |
| `scripts/test/docs.test.mjs`                          | Retain R08      | Local links/anchors, path containment, fenced JSON and multi-document/duplicate-key YAML.                           |

### Examples and scripts (13 files)

| File                                                   | Outcome    | Reviewed responsibility                                                                     |
| ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `packages/ssh-manager/examples/embedded.mjs`           | Retain R04 | Independent embedding, polling/cancellation and manager shutdown.                           |
| `packages/ssh-manager-runtime/examples/list-hosts.mjs` | Retain R04 | Explicit private state directory and client-only detach without daemon termination.         |
| `scripts/lib/consumer-lockfile.mjs`                    | Retain R07 | Reviewed dependency graph projection to exact local tarballs; no re-resolution.             |
| `scripts/lib/repository-docs.mjs`                      | Retain R07 | Offline Markdown/YAML ownership, slug parsing and contained local references.               |
| `scripts/lib/ssh-runtime-artifact-production.mjs`      | Retain R07 | Source/output separation, staging, verified inventory, promotion and recoverable rollback.  |
| `scripts/lib/ssh-runtime-artifact.mjs`                 | Retain R07 | Standalone read-only consumer verifier, trusted pin and complete bounded inventory.         |
| `scripts/lib/ssh-runtime-bundle.mjs`                   | Retain R07 | Canonical source discovery, package aliases, license provenance and deterministic outputs.  |
| `scripts/repo/check-docs.mjs`                          | Retain R07 | Tracked/non-ignored discovery and actionable checker exit status.                           |
| `scripts/ssh/build.mjs`                                | Retain R07 | Ordered package compilation and canonical-source bundle production.                         |
| `scripts/ssh/check-packages.mjs`                       | Retain R07 | Tarball allowlist, exports, exact workspace versions and isolated offline consumer imports. |
| `scripts/ssh/export-artifact.mjs`                      | Retain R07 | Clean committed source, build-input hashes and sanitized export failures.                   |
| `scripts/ssh/test.mjs`                                 | Retain R07 | Test inventory and bounded Node runner; no second check framework.                          |
| `scripts/ssh/verify-artifact.mjs`                      | Retain R07 | Trusted consumer pin/revision arguments and sanitized verification errors.                  |

### Remaining repository inventory

The other 51 baseline files are documentation/configuration or the generated lockfile, not handwritten application/test code. Their classification and disposition are explicit below. The new ADR and this specification add two documentation files, making 113 non-ignored paths. Governing architecture, security, artifact, contribution and validation documents were checked for conflicts. No workflow/dependency/configuration change is part of this work.

| Directory                                             | Files                                                                                                                                                                                                                                                                        | Disposition                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root                                                  | `.gitattributes`, `.gitignore`, `.oxfmtignore`, `oxfmt.json`, `package.json`, `pnpm-workspace.yaml`                                                                                                                                                                          | Retain source-byte, exclusions, formatting, command and dependency policies.                                                                      |
| Root                                                  | `AGENTS.md`                                                                                                                                                                                                                                                                  | Add the short accepted-ADR navigation rule; preserve existing operational instructions.                                                           |
| Root                                                  | `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `GLOSSARY.md`, `GOVERNANCE.md`, `LICENSE`, `README.md`, `SECURITY.md`, `SUPPORT.md`                                                                                                                                 | Retain documentation, public policy and license; no behavior/release promise changes.                                                             |
| Root                                                  | `pnpm-lock.yaml`                                                                                                                                                                                                                                                             | Generated dependency inventory; preserve pre-existing bytes and exclude from savings.                                                             |
| `.github/ISSUE_TEMPLATE/`                             | `bug_report.yml`, `config.yml`, `feature_request.yml`, `question.yml`                                                                                                                                                                                                        | Retain issue intake and safe diagnostic expectations.                                                                                             |
| `.github/`                                            | `PULL_REQUEST_TEMPLATE.md`, `dependabot.yml`                                                                                                                                                                                                                                 | Retain review evidence and dependency-update policy.                                                                                              |
| `.github/workflows/`                                  | `codeql.yml`, `validate.yml`                                                                                                                                                                                                                                                 | Retain read permissions, explicit qualification and three-platform/native/browser CI boundaries.                                                  |
| `docs/`                                               | `architecture.md`                                                                                                                                                                                                                                                            | Add one local ADR index and specification link; retain architectural diagrams and contracts.                                                      |
| `docs/`                                               | `README.md`, `artifact-contract.md`, `comparison.md`, `compatibility.md`, `configuration.md`, `getting-started.md`, `library.md`, `mcp.md`, `operations.md`, `project-readiness.md`, `releases.md`, `roadmap.md`, `security-model.md`, `troubleshooting.md`, `validation.md` | Retain guidance/contracts; local links, examples and YAML remain under existing checks.                                                           |
| `docs/specs/`                                         | `open-source-readiness-spec.md`                                                                                                                                                                                                                                              | Retain the separate readiness scope and evidence limits.                                                                                          |
| Each of the three `packages/ssh-manager*` directories | `README.md`, `package.json`, `tsconfig.json`                                                                                                                                                                                                                                 | Retain public packaging, exports and compiler configuration. The three already-modified manifests remain byte-identical to the worktree baseline. |
| `docs/adrs/`, `docs/specs/`                           | `0001-behavior-preserving-code-simplification.md`, `codebase-simplification-spec.md`                                                                                                                                                                                         | New local rule and this complete evidence record, included in documentation accounting.                                                           |

## Initial simplification validation

Environment: Linux, NixOS in WSL distribution `nixos`, Linux-native checkout/tools, Node `v24.21.0`, pnpm `12.9.1`, existing `agent-browser 0.38.2`. No dependency/tool installation or machine configuration was needed. The sandbox's private-network filter initially blocked a loopback daemon check; authorized execution outside that filter ran only the existing temporary fixtures. No real SSH target, personal state directory or user browser session was used.

| Check                                                                                                                                                                                                           | Result and scope                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Characterization before relevant extraction                                                                                                                                                                     | Resource-list regression against the original core; extended CLI checks against the old bundle; inspection-at-capacity assertion before C03: all passed.                                                                                              |
| `pnpm build`                                                                                                                                                                                                    | Passed after the final code edit; package compilation and canonical-source bundle.                                                                                                                                                                    |
| `node --test --test-timeout=60000 packages/ssh-manager/test/management.test.mjs packages/ssh-manager/test/faults.test.mjs packages/ssh-manager/test/recovery.test.mjs packages/ssh-manager/test/state.test.mjs` | Passed: 19 tests, no skips, after C03.                                                                                                                                                                                                                |
| Temporary bidirectional `CredentialRef` compile proof                                                                                                                                                           | Passed with `--strict --exactOptionalPropertyTypes false` and `true` after retaining the original public declaration. The incompatible trial alias was rejected, not shipped.                                                                         |
| Native command below                                                                                                                                                                                            | Passed: one real OpenSSH/encrypted-key/agent/SFTP/tmux fixture, no skip.                                                                                                                                                                              |
| Browser command below                                                                                                                                                                                           | Passed: one real viewer fixture, no skip; typing/paste, writer exclusivity, reattachment and memory-only tokens.                                                                                                                                      |
| `pnpm validate`                                                                                                                                                                                                 | Final aggregate passed after C03: formatting, build, docs, 111 passing tests, two opt-in skips and independent package-consumer checks. Both skipped fixtures passed separately above.                                                                |
| Hosted Linux/macOS/Windows CI and public artifact export                                                                                                                                                        | Not run. Local WSL qualification does not imply other-platform CI. Export requires clean committed source; this checkout intentionally retains existing and task changes. Synthetic producer/verifier/provenance/rollback tests run in the aggregate. |

```sh
SSH_MANAGER_NATIVE_TESTS=1 SSH_MANAGER_SSHD="$(command -v sshd)" SSH_MANAGER_TMUX="$(command -v tmux)" node --test --test-timeout=60000 packages/ssh-manager/test/native.test.mjs
SSH_MANAGER_BROWSER_TESTS=1 node --test --test-timeout=60000 packages/ssh-manager-runtime/test/viewer.test.mjs
```

The initially checked handwritten candidate is SHA-256 `eda6d539c464c9ef5322420a2d0b737fa70257a4f3382b7b5f1d4e0a9909e226`, computed over sorted repo-relative paths for the 60 code files, concatenating UTF-8 path, NUL, file bytes, NUL. This identifies the uncommitted code/test/script/example snapshot, not a published source revision. Documentation is accounted separately so recording results does not invalidate code evidence. Dependencies remain exactly those in the captured worktree baseline.

## Initial simplification accounting and completion

Physical lines include comments, blanks, helpers, tests and examples; no files were moved, minified or excluded to produce a reduction. Additions/deletions compare captured worktree bytes with the final files, including both new documents. Generated ignored build/dependency output is excluded from the source metric; the tracked generated lockfile is shown separately. Existing manifest/lockfile changes are not attributed to this task.

| Category                           | Files before → after | Lines before → after | Added   | Deleted | Net      |
| ---------------------------------- | -------------------- | -------------------- | ------- | ------- | -------- |
| Production                         | 29 → 29              | 6,058 → 5,990        | 127     | 195     | −68      |
| Tests/fixtures                     | 18 → 18              | 3,570 → 3,636        | 99      | 33      | +66      |
| Examples                           | 2 → 2                | 44 → 44              | 0       | 0       | 0        |
| Scripts                            | 11 → 11              | 918 → 918            | 0       | 0       | 0        |
| **All handwritten code**           | **60 → 60**          | **10,590 → 10,588**  | **226** | **228** | **−2**   |
| Documentation/configuration        | 50 → 52              | 2,044 → 2,271        | 227     | 0       | +227     |
| Generated tracked lockfile         | 1 → 1                | 1,594 → 1,594        | 0       | 0       | 0        |
| **All tracked/non-ignored source** | **111 → 113**        | **14,228 → 14,453**  | **453** | **228** | **+225** |

The reduction is deliberately modest: added contract proof consumes most of the 68 production lines removed. The maintenance improvement is concrete: one authorized-list mechanism instead of four, one capacity calculation instead of two, existing option/result declarations reused by their implementations, one CLI serialization path, one file-query shape, one sanitized endpoint failure, one disconnected-state update and one fixture profile projection. New helpers and documentation are fully included; this is not a claim of a large repository shrink.

The final complete source/consumer pass found no further evidenced qualifying candidate within the approved behavior-preserving scope. R01–R08 remain justified retain decisions. All existing assertions and negative cases remain, the four pre-existing modified files are preserved, and no commit, publish, merge or live-state change was made. The final aggregate and both optional fixtures passed; only documentation changed afterwards, with formatting/documentation checks repeated. This completed the initial simplification snapshot. The separately approved performance follow-up and PR candidate are qualified below; the initial measurements and line reduction are historical, not claims about the later snapshot.

## Performance follow-up and PR candidate

The approved follow-up removes two specific costs while preserving the extracted owners: skip the target filter when no target ID is supplied, and evaluate target saturation only when the caller needs it. Lists still snapshot their input before checking authority and copy results only after all checks. Pool capacity snapshots established and pending entries once; direct counts replace temporary filter arrays. Acquisition still collects all saturated targets for eviction. Inspection first checks the transport budget, then stops at the first saturated route profile. Connection reuse, queue cancellation, errors, public APIs/types, data formats and runtime/viewer behavior are unchanged.

The fixed follow-up baseline is the initial candidate `eda6d539c464c9ef5322420a2d0b737fa70257a4f3382b7b5f1d4e0a9909e226`. Its bytes and original dependency edits were captured before the new tests or code edits. The extended management/recovery characterization passed on the old build (18 tests), then all four focused core files passed on the optimized build (25 tests). Coverage now explicitly includes connection-list order, caller-owned copies, revoked grants for operators as well as agents, shutdown, separate total/per-target limits during and after authentication, reuse at capacity, and eviction of the oldest eligible connection rather than an unrelated idle entry. Existing waiter-cancellation coverage remains.

While preparing the requested PR, `main` advanced to `ca1fa8637bf2a59e24af6880dcd2d5cd948e461d` through PR #7. An isolated PR worktree includes that existing artifact-path fix unchanged. The two inherited script/test files were reviewed and their tests are included in the final aggregate; their 79 added net lines are not attributed to this task. The three pre-existing package-manifest changes and lockfile change remain byte-identical in the original workspace and are excluded from the PR. The PR uses the unchanged `main` dependency graph, including Zod 4.6.5; 98 existing packages were installed offline from the local store, with no downloads or install scripts. The original workspace retains Zod 4.6.6.

### Paired microbenchmark

Both actual compiled implementations ran in the same Node v24.21.0 process on Linux/NixOS WSL, using the same pinned PR dependencies and synthetic data. Each case had five warm-up blocks and twenty measured blocks per variant, alternating execution order. List blocks ran 10,000 operations; inspection blocks ran 2,000. Values below are **median [p10–p90] nanoseconds per operation**, not latency percentiles of individual requests. The temporary 111-line harness has SHA-256 `e77f06a28007e8457662a08345d1ecd7972832955e7cc047b693b1eb197721c8`; it is a disposable validation asset, not maintained application or test code.

List cases cover 0, 16 and 128 entries with no target, a matching target and a missing target. Inspection calls the actual pool method, with in-memory entries and a transport stub: one profile or five profiles (four jump hosts), free budgets, and independent total/per-target saturation caused by established or pending connections. Free pools have eight established and four pending routes; total saturation fills the 128-transport budget as far as the route length permits with unrelated profiles; target saturation has sixteen routes sharing the inspected profiles. Limits remain 128 transports and sixteen connections per target. Network I/O, actual SSH authentication, persistent authorization/audit work, throughput and heap consumption are not measured; inspection timings include promises and errors.

| Case (`inspect` count includes the target) | Before, ns/op    | After, ns/op     | Median change |
| ------------------------------------------ | ---------------- | ---------------- | ------------- |
| `list/0/none`                              | 27 [22–37]       | 30 [21–40]       | +13.8%        |
| `list/0/matching`                          | 35 [29–49]       | 35 [24–52]       | -0.2%         |
| `list/0/missing`                           | 26 [20–30]       | 26 [20–35]       | +1.8%         |
| `list/16/none`                             | 244 [232–266]    | 206 [193–243]    | -15.7%        |
| `list/16/matching`                         | 199 [195–215]    | 190 [180–207]    | -4.6%         |
| `list/16/missing`                          | 60 [52–67]       | 54 [48–58]       | -10.4%        |
| `list/128/none`                            | 2007 [1875–2151] | 1734 [1639–1953] | -13.6%        |
| `list/128/matching`                        | 1449 [1405–1576] | 1450 [1393–1516] | +0.0%         |
| `list/128/missing`                         | 368 [357–399]    | 325 [310–339]    | -11.6%        |
| `inspect/1/free`                           | 1039 [881–1288]  | 954 [798–1656]   | -8.2%         |
| `inspect/1/total-established`              | 4362 [4222–4536] | 3943 [3682–4134] | -9.6%         |
| `inspect/1/total-pending`                  | 4374 [4182–4814] | 3914 [3679–4424] | -10.5%        |
| `inspect/1/target-established`             | 3755 [3608–4530] | 3658 [3469–4380] | -2.6%         |
| `inspect/1/target-pending`                 | 3697 [3485–4099] | 3561 [3400–4010] | -3.7%         |
| `inspect/5/free`                           | 1489 [1378–1750] | 1535 [1337–1706] | +3.1%         |
| `inspect/5/total-established`              | 4528 [4412–4974] | 3685 [3455–3832] | -18.6%        |
| `inspect/5/total-pending`                  | 4609 [4374–4865] | 3666 [3484–4002] | -20.5%        |
| `inspect/5/target-established`             | 4529 [4414–4689] | 3756 [3529–3967] | -17.1%        |
| `inspect/5/target-pending`                 | 4522 [4412–4967] | 3726 [3602–3952] | -17.6%        |

Unfiltered populated lists show 14–16% lower medians; saturated inspections with four jump hosts show 17–21% lower medians with separated p10–p90 ranges. Empty lists, matching-target lists and free pools mostly overlap in measurement spread, so no improvement is claimed for those cases. A preceding run using the original workspace dependencies showed the same direction for populated unfiltered lists and saturated jump-route inspections. The small positive differences in the final table are within spread and were not reproduced in that earlier run; no reproducible slowdown was observed. This establishes removal of local metadata work, not a general SSH performance or memory claim. No timing assertions or benchmark dependency were added to CI.

### Final local qualification

| Check                              | Result and evidence boundary                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original workspace `pnpm validate` | Passed: 117 tests, two opt-in skips, formatting/build/docs/package consumers; original dependency edits preserved.                                    |
| PR candidate `pnpm validate`       | Passed: 119 tests, two opt-in skips, formatting/build/docs/package consumers. The two extra tests come from the inherited artifact fix.               |
| PR native command recorded above   | Passed: one OpenSSH/encrypted-key/agent/SFTP/tmux fixture, no skips.                                                                                  |
| PR browser command recorded above  | Passed: one real viewer fixture, no skips.                                                                                                            |
| Final evidence/changelog edits     | Documentation only; formatting and documentation checks repeated after recording results.                                                             |
| Hosted CI, release and live SSH    | Hosted outcomes belong to the PR's checks, not these local results. No release, package publication, merge or live-state change is part of this task. |

The final original-workspace handwritten hash is `3ff4b60590e1f6325789bf55ba3cef7c932b2af24607450783955c381a1cfd5a`; the final PR handwritten hash is `f2c45e00f40b642f32ff8532aecb70e26e7656271e1259789be0fb76c641af55`, using the same sorted-path/NUL/content scheme as the original inventory. The hashes differ only because the PR includes the two inherited artifact-fix files. Compiled canonical-library JavaScript is byte-identical between the two candidates. All affected consumers were revisited; C01 and C03 keep their boundaries, and R01–R08 remain retained.

### Follow-up accounting

The performance step adds **78 test lines and zero net production lines** to the initial simplified workspace: handwritten code goes from 10,588 to 10,666 lines. Against the original 10,590-line baseline that is now **+76**, rather than the historical −2. The PR adds the separately inherited 79 lines, resulting in 10,745 handwritten lines against its 10,669-line `main` base. There is no final overall code-reduction claim: production remains 68 lines smaller, while regression coverage grows. The original savings baseline is not reset and the upstream work is not credited as task savings.

| PR category    | Base lines | Final lines | Added   | Deleted | Net      |
| -------------- | ---------- | ----------- | ------- | ------- | -------- |
| production     | 6,058      | 5,990       | 127     | 195     | -68      |
| tests/fixtures | 3,636      | 3,780       | 177     | 33      | +144     |
| examples       | 44         | 44          | 0       | 0       | +0       |
| scripts        | 931        | 931         | 0       | 0       | +0       |
| docs/config    | 2,044      | 2,341       | 297     | 0       | +297     |
| lockfile       | 1,594      | 1,594       | 0       | 0       | +0       |
| **All source** | **14,307** | **14,680**  | **601** | **228** | **+373** |

Counts include all tracked and non-ignored source additions, including the ADR, this specification, changelog and regression tests. Generated builds/dependencies, isolated worktree copies and temporary validation snapshots/harnesses are outside maintained-source accounting, consistently with the initial inventory. The existing four dependency edits are preserved in the original workspace; they are absent from the PR diff. Public declarations, package exports, security/lifecycle contracts and runtime adapters retain the validated behavior. The changes are ready for the requested PR; publication, merge and live operations remain outside scope.

## Managed runtime fixture ownership

The separately approved architecture follow-up starts from clean source revision `ef94a28d26b0c59bdd528cae4c50c0f97027c159`. Its complete scope is `packages/ssh-manager-runtime/test/api.test.mjs`, `client-lifecycle.test.mjs`, the new runtime `test/fixture.mjs` and `test/fixture-lifetime.test.mjs`, `GLOSSARY.md` and this specification. A private baseline captures original file bytes and records both new paths as absent. Production, dependencies, generated output and other contributors' worktrees are outside this change.

The runtime test fixture owns its temporary state, local runtime and authenticated operator/agent clients. Both existing callers use that owner instead of repeating acquisition and chained cleanup. Ownership is registered before allocation or asynchronous setup, each client is retained before registration, and partial setup rolls back. Every cleanup step is attempted after earlier failures; setup and cleanup errors remain observable together. Repeated close shares one promise and the same success or aggregated failure. Fixture clients use existing strict cleanup so detach failures cannot disappear into best-effort close.

Target setup, human grants, TTL/heartbeat behavior, WebSocket writer checks and all original scenario assertions remain in the callers. Heartbeat cleanup is registered before runtime acquisition so it runs before runtime release. The synthetic SSH counterpart remains independently owned, as do browser, daemon and native fixtures. This is a narrow follow-up to retained R08, not a shared fixture framework or a change to public management behavior.

### Contract evidence

The new lifetime tests exercise the fixture interface with real loopback runtime/client resources. They cover actual test-lifetime release; allocation, runtime startup and either client-registration failure; failed hook registration; all four cleanup stages failing; repeated-close promise/error identity; and combined setup/rollback failure. A failed client remains owned, closed listeners and removed state are checked, and failed state removal remains visible. Faults use existing test mocks; no production injection seam is added.

| Check                                             | Result                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Focused fixture and both existing caller files    | 16 tests passed, no skips.                                                                          |
| `pnpm validate`                                   | Passed: 278 tests, three optional skips; formatting, build, docs and offline package checks passed. |
| Available native/browser fixtures via `pnpm test` | Passed: 280 tests, one Windows-only skip; real isolated OpenSSH/tmux and browser fixtures ran.      |
| Hosted, published and live SSH evidence           | Not established for this uncommitted change; no publication or live SSH operation is included.      |

### Follow-up accounting and completion

The totals below compare all six scope paths with the fixed baseline and include both new support files. No generated files or pre-existing edits are attributed. These are incremental totals for this follow-up; historical accounting above is unchanged.

| Category        | Added | Deleted | Net  |
| --------------- | ----- | ------- | ---- |
| Production      | 0     | 0       | 0    |
| Tests/fixtures  | 249   | 46      | +203 |
| Documentation   | 35    | 0       | +35  |
| All scope files | 284   | 46      | +238 |

No code-reduction claim applies. One owner replaces repeated runtime setup/cleanup obligations, while regression proof increases maintained code. The final complete pass over this bounded scope found no further qualifying candidate: test-specific SSH approvals, expiry controls and direct protocol probes remain with their scenarios. Expanding fixture ownership requires another actual caller with matching acquisition and cleanup semantics. MCP request ownership remains a separate unimplemented architecture candidate.
