# Compatibility and limitations

**Early-stage / best effort.** Version numbers identify software, not a support SLA, public release, security certification or universal compatibility promise.

## Runtime requirements

- Node.js **24.18.0 or newer**; CI uses 24.18.0. Newer Node versions are not all independently qualified.
- pnpm **12.9.1** for source development; the standalone runtime bundle only needs Node.
- Native state owned by one OS user, with separate directories for independent embedded instances or daemon environments.
- Optional tmux must already exist on a compatible Unix target. It is never installed automatically.

## Evidence matrix

| Surface                     | Existing check                                                                                     | What it does not prove                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Linux, macOS, Windows hosts | Hosted matrix builds, default temporary SSH/API/MCP fixtures and artifact export                   | Every host distribution, target OS, corporate proxy or native credential-agent implementation |
| Unix native SSH/tmux        | Opt-in isolated OpenSSH, key-file/agent and tmux-recovery fixture; CI runs on Linux/macOS          | Windows native OpenSSH/tmux support or production reboot survival                             |
| Browser viewer              | Real agent-browser/Chrome fixture: input/paste, writer expiry, detach/reattach, memory-only tokens | Safari/Firefox/mobile/accessibility qualification or every Chrome release                     |
| MCP                         | Protocol fixtures for legacy `2025-06-18` initialization and `2026-07-28` discovery/envelopes      | Installation and approval UX of every MCP host                                                |
| Consumer packages           | Local tarball inventory and workspace-dependency rewrite checks                                    | Public registry publication or all consumer bundlers                                          |
| Runtime bundle              | Reproducible canonical-source builds; manifest/inventory tests                                     | Signed publisher identity, actual publication or a live install switch                        |

The last pre-readiness main workflow inspected was [run 38283554540](https://github.com/stark-ai-de/ssh-manager/actions/runs/38283554540), at source `9e6fb23d451b2900d8ea1653cf6d578cc20b4fa4`. Consult the [current workflows](https://github.com/stark-ai-de/ssh-manager/actions) for evidence for a newer revision. Adding a CI job is not evidence it has run successfully.

## Known boundaries

- SSH `known_hosts` support includes ordinary patterns/hashed names and revocation checks, not host certificates/CA authentication.
- SSH config import is a safe subset, not full OpenSSH configuration evaluation. No `ProxyCommand` execution, `Include` expansion, `Match` evaluation or implicit key/trust import.
- `posix`, `powershell` and `cmd` shell modes exist. Fixtures pin their exact job and interactive launch commands; that is not native Windows OpenSSH target qualification.
- Key exchange, host-key, cipher and MAC negotiation use the ssh2 1.17.0 defaults. There is no automatic fallback to weaker or legacy algorithms; a server that offers only those fails the handshake.
- Password credentials also answer one hidden `keyboard-interactive` prompt. Multi-factor or other challenge prompts are not supported.
- WSL and Windows have separate default state and credential contexts. Do not share one live directory across them.
- The viewer attaches to existing sessions; it is not a full graphical host/vault administration application.
- Authentication/grants are local and shared by the state owner; there is no SSO, multi-tenant RBAC, cloud synchronization or hosted control plane.
- Plain PTYs do not survive SSH loss or daemon restart. tmux recovery checks the remote session still exists. Jobs are never automatically rerun.
- Output/recording/audit retention is bounded. A cancelled job may leave remote descendants; an interrupted upload may leave a partial file.

See [comparison](comparison.md) for tools that better fit other needs, and [validation](validation.md) for reproducing the available evidence.
