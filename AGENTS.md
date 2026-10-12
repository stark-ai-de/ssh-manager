# SSH Manager

- Use Linux development tools and preserve other contributors' changes.
- Canonical management code lives in `packages/ssh-manager`; it imports neither HTTP nor MCP.
- The runtime owns SSH connections and sessions. MCP uses the authenticated management API only.
- Preserve host verification, human target grants, credential isolation and authenticated writer identity across every access path.
- Never replay jobs on reconnect or claim lost PTYs continued. Vault lock does not terminate existing authenticated sessions.
- Keep secrets, local state, private paths and identifying host data out of source and artifacts.
- Run `pnpm validate` after implementation changes; run relevant native/browser fixtures when their existing prerequisites are available.
- Artifact export requires clean committed source and records that exact source revision. No dependency installation at MCP startup.
- Publish, merge and change live SSH state only with explicit authorization.
- See `docs/architecture.md`, `docs/operations.md` and `docs/artifact-contract.md`.
