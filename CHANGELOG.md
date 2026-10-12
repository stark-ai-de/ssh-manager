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

### Changed

- `pnpm validate` now includes formatting, documentation and consumer-package checks as well as build/tests.
- README now explains intended audiences, early-stage support, safe onboarding and project boundaries.

No SSH runtime behavior, authentication model, state format or public API was intentionally changed. No GitHub Release, npm publication or live-state migration is implied by this entry.
