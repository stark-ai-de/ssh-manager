---
title: Verified management-client and MCP integration
slug: verified-client-integration
artifact_path: docs/specs/verified-client-integration-spec.md
mode: standard
status: approved
created: 2026-10-16
updated: 2026-10-16
source_request: Review and remediate PR 9, document the feature, validate, and update the existing PR last.
---

# Verified management-client and MCP integration

## Goal and approved scope

Trusted applications can embed the canonical management client, session streams and MCP entry while verifying real connections and retaining ownership until physical completion. Close all confirmed findings on [PR 9](https://github.com/stark-ai-de/ssh-manager/pull/9), retain the existing feature, and provide regression evidence for each reviewed contract.

The reviewed baseline is `cf9511e50898ac6d77bb9758cae62493f36b77cb`. Review found eleven outstanding defects (five P1 and six P2) and one already addressed write-ordering finding requiring focused regression evidence. Review summaries and outdated threads are included. CodeRabbit skipped its review; its status is not an independent code review.

The maintainer approved this specification and implementation on 2026-10-16, including immediate connection shutdown on malformed MCP frames and evidence-backed replies/resolution of fixed review threads. Preserve unrelated work and use the existing PR branch. Do not merge, release, deploy, alter live SSH targets, repin another product or install a second global toolchain.

## Feature contract

- Canonical management owns SSH policy, credentials, host trust, human grants and resource lifecycles. Runtime clients use the authenticated management API. MCP may invoke operations only through a registered agent identity. Host verification, credential isolation and authenticated writer ownership apply across supported access paths.
- `ManagementClient` retains its existing constructor and additive options. Authority hooks verify the actual exchange/socket; exchange enrollment precedes body traversal and network work. `result` and `settled` are separate: an answer, timeout or cancellation alone never releases physical capacity. `joinPhysical` joins real completion, including failure.
- Registration validates actor ID/kind, token and lifetime before publication. Public metadata never includes tokens. A cancelled sent registration remains private and attempts one sequential own detach using its original authority and ordinary capacity. Cancellation of another waiter affects only that waiter.
- Ordinary JSON calls default to 30 seconds, registration and heartbeat to five seconds, and detach to two seconds. Upload/download have no implicit overall deadline; explicit timeout and cancellation remain available. Existing payload bounds and backpressure remain enforced.
- Client and shared-transport ordinary/control capacities remain independent ownership limits. Both required fields are positive safe integers. Only heartbeat, own-client detach and explicitly selected own-session detach may use control capacity. Hosts still prove exact own-session bindings; session detach retains its catalog response bound.
- Locally malformed responses after a sent exchange revoke the actual authority and prevent further authorized sends. Validated remote domain errors retain their existing public semantics, even when their code resembles a local decoder error. Strict cleanup reports unresolved effects only after all owned work finishes; legacy best-effort behavior remains compatible.
- Session streams keep private tokens, bounded queues, verified socket checks and exact reader cleanup leases. Local physical settlement does not acknowledge remote reader/writer detach. Reconnect never replays jobs or claims lost PTYs continued; vault lock does not terminate existing authenticated sessions.
- Canonical MCP retains the full non-operator catalog, schemas, annotations and official SDK dispatch. `beforeCall` receives validated arguments before registration/invocation. Both normal and custom `invoke` paths await registration/physical completion and require an agent client. Trusted callbacks cannot grant operator authority.
- MCP defaults remain eight requests, sixteen held messages, two active/eight waiting calls, at most two owned clients/factories, and the documented finite input/output budgets. IDs and capacity remain owned through handler, factory, subscription, write and cleanup tails. There is no request-count lifetime or ten-minute expiry.
- Framing/JSON-RPC-envelope errors synchronously close admission and start complete cleanup. Subsequent requests cannot enter. Valid JSON-RPC requests with invalid tool arguments still receive ordinary MCP errors. Keep the official decoder and existing raw-buffer bound. Bounded raw-line validation may call the SDK's public decoder to surface syntax errors its buffer otherwise discards; no independent JSON/MCP parser is introduced.
- `@stark-ai/ssh-manager-runtime/cli` exports the existing scoped CLI function and feature flag with types. CLI/MCP module and artifact imports are side-effect-free from files, stdin and eval; direct invocation still starts the entrypoint.

## Architecture and source challenge

ADR required: **no**. The corrections implement documented contracts inside the existing owners; [ADR-0001](../adrs/0001-behavior-preserving-code-simplification.md), [architecture](../architecture.md), [security model](../security-model.md) and [artifact contract](../artifact-contract.md) remain binding. No accepted decision is superseded, and no storage migration is required.

Source review covered the PR head, all review threads and discussion summaries, the client/transport/session and MCP owners, package export maps, tests, build manifests and the installed published SDK source. The SDK stays pinned to `@modelcontextprotocol/server` 2.3.1 with its existing source-digest audit. Upstream SDK changes are not a delivery dependency.

Use `import.meta.main` for entrypoint detection: [Node 24 documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/esm.html#importmetamain) establishes support before the repository's Node 24.18 minimum. Existing filesystem guards incorrectly assume `argv[1]` names a file. Existing passing tests also allowed unauthenticated custom MCP invocations; those fixtures need genuine synthetic registrations.

The review's focused baseline had 60 passing existing tests. An additional declaration fixture could not create its temporary directory under the read-only review environment. Baseline results are not implementation validation.

## Finding-to-acceptance matrix

| Review thread                                                                                                            | Correction and required regression                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [4288316106: transfer deadline](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316106)                | No default upload/download lifetime; preserve JSON/control deadlines. Test slow transfers, explicit timeout and cancellation.                                                                                                                                                    |
| [4288316114: custom invocation authentication](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316114) | Both invocation paths require completed agent registration. Operator, failed registration and cancelled calls never reach custom invoke.                                                                                                                                         |
| [4288316120: control capacity](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316120)                 | Reject non-control routes and invalid classes before any custom transport dispatch, including exhausted ordinary capacity.                                                                                                                                                       |
| [4288316124: connect waiters](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316124)                  | Secondary cancellation leaves the registration owner and other waiters intact; owner cancellation retains exactly one original-authority detach.                                                                                                                                 |
| [4288316130: physical client tails](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316130)            | All-settled joining covers exchanges and streams before strict or best-effort close settles. Test rejected plus held tails and stable repeated close.                                                                                                                            |
| [4288316139: malformed responses](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316139)              | Distinguish local structural failures from remote errors; revoke constructor/per-call authority, sanitize errors and deny subsequent sends.                                                                                                                                      |
| [4288316143: MCP client cleanups](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316143)              | Real SDK modern-probe to legacy fallback owns two clients: one rejected cleanup cannot settle close while the other is held. Uncertain ownership remains charged.                                                                                                                |
| [4288316148: final response writes](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316148)            | Preserve the existing ordering; hold an invocation that queues its final response after close begins and require the real write callback before close settles.                                                                                                                   |
| [4288316156: CLI package export](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288316156)               | Installed tarball consumers import the CLI function/feature flag and resolve its declarations.                                                                                                                                                                                   |
| [4288650752: required capacity fields](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288650752)         | Empty, incomplete and invalid policies fail before I/O; both valid classes remain charged through physical completion.                                                                                                                                                           |
| [4288650765: malformed input frames](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288650765)           | Real official stdio, with bounded raw-line validation through the public SDK decoder for silently discarded syntax errors, rejects further work after the first malformed frame, joins held work/cleanup, and still handles valid requests with invalid tool arguments normally. |
| [4288650770: import guards](https://github.com/stark-ai-de/ssh-manager/pull/9#discussion_r4288650770)                    | File/stdin/eval and package/bundle imports do not start or throw; direct entrypoints continue to work.                                                                                                                                                                           |

## Implementation and validation

Make bounded corrections in the existing runtime client, MCP owner and entrypoints. Keep private helpers local to their existing owners; do not introduce a generic lifecycle framework. Extend existing HTTP/custom-transport, session, real SDK/stdio and package-consumer fixtures. Reconcile the client integration and MCP lifecycle documents, then review the complete diff.

Use the repository's pinned pnpm 12.9.1 and managed Linux Node 24.18 or newer. Resolve writable tool-store requirements without silently changing versions or weakening lockfile/supply-chain policy. Run focused regressions first, then:

```sh
pnpm validate
pnpm test:mcp:duration
SSH_MANAGER_NATIVE_TESTS=1 SSH_MANAGER_SSHD="$(command -v sshd)" SSH_MANAGER_TMUX="$(command -v tmux)" pnpm test
SSH_MANAGER_BROWSER_TESTS=1 pnpm test
```

The duration check runs for at least 602 seconds in both protocol generations, reuses IDs, covers the canonical catalog and checks bounded ownership. Native/browser checks use isolated fixtures only. After committing clean source, run `pnpm artifact`, verify inventory/digests against the exact source commit, and test the exported entrypoint imports. Package checks cover the added CLI export and types.

Local, hosted CI, artifact and native/desktop qualification are separate evidence. Mechas native receipts, signed helpers and final desktop qualification are excluded. Missing prerequisites or failed checks must be recorded, never represented as passes.

## Implementation evidence

On 2026-10-16 all eleven confirmed defects were corrected and the existing final-write ordering received focused regression coverage. The [client regressions](../../packages/ssh-manager-runtime/test/client-review.test.mjs), [real SDK/stdio regressions](../../packages/ssh-manager-mcp/test/stdio-review.test.mjs), [entrypoint imports](../../scripts/test/entrypoint-imports.test.mjs) and [installed-package check](../../scripts/ssh/check-packages.mjs) cover the matrix above. Existing original-authority late-registration and session-lease tests remain intact.

The final implementation passed `pnpm validate` with pnpm 12.9.1 and Node 24.22.0: 221 tests, 219 passed, two optional native/browser fixtures skipped, plus formatting, build, documentation and installed-tarball/type checks. Separate native and browser runs each passed 220 tests with the other optional fixture skipped. The full duration check passed after 602.117 seconds with 19,144 completed calls per protocol generation, all 43 catalog entries, reused IDs and the expected bounded ownership counts. All 43 build-input hashes and the unchanged SDK digests matched. The resulting commit, clean-source artifact digest and fresh hosted CI outcomes are recorded on PR 9 after publication; earlier hosted results are not evidence for these corrections.

## Delivery, rollback and done conditions

1. Save and read back this approved specification before implementation; no additional spec approval is required for the unchanged plan.
2. Complete fixes, regressions and documentation; run the required local checks and commit only this work. Recheck the remote PR head/comments before pushing and preserve concurrent work.
3. Push the existing PR branch without force; inspect the new hosted checks and repair relevant failures. Earlier CI results do not qualify the new commit.
4. Reply to each proven fixed thread with commit/test evidence and resolve it. Keep any unproven item open; include the already addressed write-ordering finding only after its focused proof.
5. Make the PR description the final write, linking this specification and recording the finding disposition and actual validation. Perform only read-only verification afterward.

Rollback is a targeted revert of these commits. No data migration, release or live-state change is involved. Knowledge synchronization remains pending until project adoption exists; no repository upload is implied.

Done means all twelve thread dispositions are evidenced, all required checks have recorded outcomes, the exact committed artifact is verified, and the existing PR reflects the final implementation. If a required gate is unavailable, report the bounded gap rather than claiming completion.

## Codex execution prompt

Implement this approved contract on the existing PR branch with minimal changes. Preserve repository instructions, ADR-0001, unrelated work and the canonical ownership boundaries. Use the finding matrix as the regression checklist. Run every listed validation gate, record actual outcomes, and update PR 9 only in the delivery order above. Implementation, commit, push and evidence-backed thread resolution were explicitly authorized; merge, release, deployment and live SSH operations were not.
