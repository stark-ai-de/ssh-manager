---
title: Open-source readiness baseline
status: implementation-scope
depth: deep
---

# Open-source readiness implementation scope

## Goal and authorization

Make the existing SSH Manager understandable, safely adoptable and maintainable as an open-source project for both TypeScript developers and MCP users. The maintainer requested the readiness audit, then explicitly requested implementation of all recommended repository improvements and adaptation of useful patterns from `stark-ai-de/agent-skills`.

This records the implemented scope; it is not a claim that an earlier complete draft was separately reviewed, that a release was approved, or that every future adoption need is solved.

## Repository context

The starting source was `9e6fb23d451b2900d8ea1653cf6d578cc20b4fa4`: three TypeScript packages, Apache-2.0, `pnpm validate`, a three-platform qualification workflow, local native/browser fixtures, canonical-source bundling and clean-commit artifact export. Initial documentation lacked onboarding depth, diagrams, community policies and comparison material.

## Scope and deliverables

1. README/documentation index and task-oriented setup, MCP, embedding, configuration, operations, troubleshooting and compatibility guides.
2. Five Mermaid diagrams across the README/architecture guide, with prose and preserved trust/lifecycle boundaries.
3. A dated, sourced fit comparison against OpenSSH, ssh2, Tabby, Termius and Teleport.
4. Contribution, support, security, conduct, governance, changelog, roadmap and issue/PR templates.
5. Package descriptions/repository metadata/READMEs and isolated offline package-consumer checks.
6. Offline Markdown-link/anchor, JSON-example and YAML-syntax checks, schema-backed guide fixtures, and a runnable typed-client example.
7. A dependency-free runtime-artifact verifier with mandatory independently trusted manifest digest and negative tests.
8. Formatting/docs/package validation integration, pinned workflow actions, browser fixture CI, dependency update and CodeQL configuration.
9. A public readiness checklist separating repository changes from administrator/publication/live-state follow-ups.

## Non-goals and invariants

No package rename, public API break, SSH behavior change, state migration, framework replacement, website build, imported skill catalog or global helper installation. No publishing, tagging, merging, external repository settings change, credential migration, real-host connection, service restart or live SSH-state modification.

Preserve canonical library ownership, authenticated API-only MCP access, human target grants, host verification, credential isolation and server-assigned writer identity. Never replay jobs or claim a lost plain PTY continued; vault lock must not terminate authenticated sessions.

## Acceptance checks

- A first-time user can follow the human setup sequence without supplying secrets through MCP or being told inspection alone verifies a host.
- JSON setup examples parse against the actual operation schemas; the agent-only typed-client example works against an isolated runtime and detaches without stopping it.
- Documentation links/headings and YAML/JSON examples pass offline checks; diagrams are also inspected in a renderer, separately from static checks.
- Package tarballs contain their documented entrypoints, README/license and rewritten workspace dependencies; an offline consumer can import all three public package APIs without starting SSH.
- Verifier tests reject missing/wrong trusted pins, wrong producer revisions, unsafe paths, malformed metadata, missing/extra/modified payload and symlinks.
- `pnpm validate` passes after changes; available native/browser fixtures run with actual skips reported.
- Artifact export still requires clean committed source and exact build-input provenance. No dirty artifact is represented as the original revision.
- Source contains no real credentials, local state, private host inventory or local absolute checkout paths.

## Source challenge and architecture decisions

Sources include `AGENTS.md`, current code/tests/catalog, architecture/operations/artifact contracts, GitHub repository settings and the pinned [Agent Skills reference](../project-readiness.md#patterns-adapted-from-agent-skills). Official product sources support the comparison. The established organization security email was discovered in the reference repository rather than invented. Teleport's documented MCP integration is acknowledged rather than incorrectly claiming MCP is unique to this project.

Existing architecture and explicit-publication policy are preserved; no new runtime/security/state architecture ADR is required. Validation/tooling additions implement these existing contracts rather than importing the reference repository's governance system. Future boundary or publishing-policy changes need a separate reviewed decision.

## Validation and rollout

Use [validation](../validation.md) for exact commands and evidence limits. Stage changes in reviewable documentation, tooling/test and workflow slices; run focused checks and the aggregate. Run browser/native fixtures only against isolated state. Export real artifacts only after maintainers commit/review the final source; do not commit solely to bypass the guard.

Rollback is a source/tooling revert with no state migration. No live daemon needs restarting for these repository changes. Hosted checks, repository settings and publication remain separate from local validation.

## Done when

The bounded repository deliverables are implemented and locally checked, source/privacy review is complete, and remaining external authorization/evidence gates are visible in [readiness](../project-readiness.md). This baseline does not claim a published release, security certification or complete platform qualification.
