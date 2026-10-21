# Changelog

User-visible changes are recorded here. `Unreleased` is not a published release, and current package versions do not establish release history.

## Unreleased

### Added

- Human first-connection, MCP, library/client, configuration, compatibility, troubleshooting and operations guides.
- Architecture, approval, terminal-lifecycle and distribution diagrams, plus a sourced alternatives comparison.
- Contribution, support, security-reporting, conduct and governance policies; issue forms and a PR checklist.
- Package READMEs/metadata and an isolated offline tarball-install/import smoke check.
- Offline documentation/YAML/JSON checks, schema-backed setup examples and a tested typed-client example.
- Runtime-artifact verification with a required trusted manifest pin and adversarial inventory fixtures.
- Browser fixture CI, pinned action revisions, CodeQL and dependency-update configuration.
- Readiness/release checklists and a roadmap with explicit external follow-ups.
- Vault password credentials answer exactly one hidden single-prompt `keyboard-interactive` round, for servers that allow only PAM-style password prompts. Other prompts receive no answer.
- Fixture tests pin the exact PowerShell and cmd job and interactive launch commands.

### Changed

- Shared SSH resource listing and capacity checks avoid redundant filtering while preserving grants, ordering and connection lifecycle behavior.
- `pnpm validate` now includes formatting, documentation and consumer-package checks as well as build/tests.
- README now explains intended audiences, early-stage support, safe onboarding and project boundaries.
- SSH config import preview no longer applies directives after `Match` to the preceding `Host`, accepts `Key = value` spacing, cites the `Host` line for per-profile warnings and returns at most 256 warnings, ending with `warnings-truncated` when more exist.
- `pnpm test` builds first when `dist/` is missing or its recorded source hashes differ.

Apart from the entries above, no SSH runtime behavior, authentication model, state format or public API was intentionally changed. No GitHub Release, npm publication or live-state migration is implied by this entry.
