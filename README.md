# SSH Manager

Independent TypeScript SSH management based on ssh2: reusable library, authenticated local API, background daemon, terminal viewer and MCP adapter. Apache-2.0; Node 24.18 or newer.

| Package                         | Responsibility                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `@stark-ai/ssh-manager`         | Hosts, credentials, trust/grants, connections, PTYs, jobs, SFTP, tunnels and audit |
| `@stark-ai/ssh-manager-runtime` | HTTP/WebSocket API, typed client, CLI, daemon and browser terminal viewer          |
| `@stark-ai/ssh-manager-mcp`     | Individual MCP tools using the management API                                      |

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm validate
node packages/ssh-manager-runtime/dist/cli.js help
node packages/ssh-manager-runtime/dist/cli.js start
```

The MCP starts this daemon on demand. Configure host trust, credentials and target grants using trusted local setup. The CLI help lists available actions. MCP cannot supply secrets or grant permissions.

The [embedded consumer](packages/ssh-manager/examples/embedded.mjs) uses the library without MCP or HTTP. `@stark-ai/ssh-manager-runtime/client` provides the typed client for applications sharing the daemon. Existing package names, public exports and `/v1/` API remain unchanged.

Optional fixture checks use only temporary SSH credentials/state:

```sh
SSH_MANAGER_NATIVE_TESTS=1 SSH_MANAGER_SSHD="$(command -v sshd)" SSH_MANAGER_TMUX="$(command -v tmux)" pnpm test
SSH_MANAGER_BROWSER_TESTS=1 pnpm test
```

Native fixtures need existing OpenSSH and tmux; browser fixtures need existing agent-browser/Chrome. Skips are reported and are not platform qualification passes.

After committing clean source, `pnpm artifact` produces the pinned plugin runtime, runnable as `node runtime/cli.mjs` or `node runtime/mcp.mjs`. No Mechas installation or SSH source checkout is needed by the installed MCP. This repository does not require npm publication to build and use its packages.

See [architecture](docs/architecture.md), [operations](docs/operations.md) and the [artifact contract](docs/artifact-contract.md). Public release and cross-platform proof are separate from local implementation tests.
