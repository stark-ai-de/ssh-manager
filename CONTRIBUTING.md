# Contributing to SSH Manager

Documentation, reproducible bug reports, tests and code contributions are welcome. Please follow the [code of conduct](CODE_OF_CONDUCT.md). For vulnerabilities, use [private security reporting](SECURITY.md), not a public issue.

## Start locally

Use Linux development tools, Node.js 24.18.0 or newer, pnpm 12.9.1 and `tar` for package checks. Fork/clone the repository, create a focused branch, then:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm validate
```

The validation command builds the packages before testing them. Default tests create temporary credentials/state and local fixtures; they must never use a contributor's real SSH agent, keys, daemon or targets. The first dependency install needs network access; the normal validation gates do not fetch documentation or contact real SSH targets.

## Source ownership

- Put SSH management behavior in `packages/ssh-manager`. It imports neither HTTP nor MCP.
- Put transport/authentication/daemon/viewer integration in `packages/ssh-manager-runtime`.
- MCP calls the authenticated management API. Do not duplicate SSH behavior in the adapter.
- Keep development checks in `scripts/`; do not add dependency installation to MCP startup.
- Edit source, not ignored `dist/` output. Preserve other contributors' work.

Read [architecture](docs/architecture.md), [security model](docs/security-model.md) and [artifact contract](docs/artifact-contract.md) before changing these boundaries. Discuss durable boundary, authentication, state-format or publishing changes with maintainers first. A documentation cleanup does not authorize a new architecture.

## Validate your change

```sh
pnpm format
pnpm validate
```

`format` modifies files; `format:check` only checks. TypeScript compilation is the type check. There is no separate mandatory lint command to guess. Add regression coverage for changed behavior, including rejected input and interrupted operations.

Run the relevant native and browser fixtures when their **existing prerequisites** are available:

```sh
SSH_MANAGER_NATIVE_TESTS=1 SSH_MANAGER_SSHD="$(command -v sshd)" SSH_MANAGER_TMUX="$(command -v tmux)" pnpm test
SSH_MANAGER_BROWSER_TESTS=1 pnpm test
```

Native tests also require `ssh-agent` and `ssh-add`; they create their own credentials, daemon and tmux socket. The browser fixture needs `agent-browser` and Chrome. See [validation](docs/validation.md) for exact proof and limitations. A skipped fixture is not a pass. Do not install or reconfigure services on someone else's machine just to run a check.

## Documentation and examples

Use reserved examples such as `server.example.test`, synthetic IDs and generic paths. Keep credentials, token values, state files, private paths, identifying host data and unsanitized screenshots out of commits, issues and artifacts. A host-key inspection is not proof that the key belongs to the intended server.

Keep the README short and link detailed guides. Update examples and tests when an API changes. Mermaid diagrams live with the explanation and need a prose equivalent. Product comparisons need official sources and a review date; do not infer that an alternative lacks a feature merely because its overview omits it.

## Pull requests

Explain the problem, scope, compatibility impact and evidence. Include:

- The tests actually run and any skipped checks with reasons.
- User-facing documentation and an `Unreleased` changelog entry when behavior changes.
- Preservation of host verification, human grants, credential isolation and authenticated writer identity.
- No automatic job replay, false PTY-continuity claim or implicit session termination on vault lock.
- Migration/rollback notes if state or compatibility changes.

A maintainer reviews and merges contributions. Do not bump versions, publish, push release tags or change live SSH state as an incidental part of a PR. See [releases](docs/releases.md). Contributions are provided under the repository's [Apache-2.0 license](LICENSE); no additional CLA or DCO process is currently required.
