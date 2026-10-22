# Changelog

User-visible changes are recorded here. `Unreleased` is not a published release, and current package versions do not establish release history.

## Unreleased

### Added

- Optional direct-library `FileScope` restricts individual SFTP operations to an immutable intersection with the existing target roots; omitted scope keeps existing grants/root behavior.

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

- Vault Argon2id uses pinned `hash-wasm` only when native crypto reports `ERR_CRYPTO_ARGON2_NOT_SUPPORTED` (for example Electron/BoringSSL). Existing parameters, encrypted vault format and native-readable output remain unchanged.

- File creation requires definite missing-leaf evidence before using a checked parent when full-path resolution fails. Existing unresolved objects fail closed; this is not an atomic remote-filesystem sandbox.

- Shared SSH resource listing and capacity checks avoid redundant filtering while preserving grants, ordering and connection lifecycle behavior.
- `pnpm validate` now includes formatting, documentation and consumer-package checks as well as build/tests.
- README now explains intended audiences, early-stage support, safe onboarding and project boundaries.
- SSH config import preview no longer applies directives after `Match` to the preceding `Host`, accepts `Key = value` spacing, cites the `Host` line for per-profile warnings and returns at most 256 warnings, ending with `warnings-truncated` when more exist.
- `pnpm test` builds first when `dist/` is missing or its recorded source hashes differ.
- Connection setup reports a refused port or failed DNS lookup as `CONNECTION_FAILED` and a stalled handshake as `TIMEOUT`, instead of `AUTHENTICATION_FAILED`. Rejected logins keep `AUTHENTICATION_FAILED`; nothing is retried.
- Session output sent to a viewer no longer extends the viewer client's registration, so a silent client expires on time. Expiry or client detach now closes that client's viewer sockets; its sessions keep running.
- `ManagementClient.close()` rejects an invalid `timeout` or `capacityClass` with `INVALID_ARGUMENT` before closing, so a later valid close still detaches.

The entries above include the stated public API and SFTP behavior changes. The authentication model and state format are unchanged. No GitHub Release, npm publication or live-state migration is implied by this entry.
