# MCP integration

The adapter exposes individual SSH tools over **stdio**. It uses the authenticated local management API and starts the daemon on demand. It does not embed another SSH engine, install dependencies at startup, or create a remote HTTP MCP endpoint.

## Configure a client

Build from source first and complete [trusted local setup](getting-started.md). A common client configuration shape is:

```json
{
  "mcpServers": {
    "ssh-manager": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/ssh-manager/packages/ssh-manager-mcp/dist/main.js",
        "--state-directory",
        "/ABSOLUTE/PATH/your-private-ssh-manager-state"
      ]
    }
  }
}
```

Replace both paths; this is an example, not an existing installation. On Windows use an absolute native Windows path with JSON-escaped backslashes (or forward slashes), not a WSL path. If your desktop client cannot find `node`, use the full path to a compatible Node executable. You may omit `--state-directory` and its following value only when both the CLI and MCP should use the same native [default](configuration.md#state-directories).

For a separately verified runtime bundle, replace the first argument with `/ABSOLUTE/PATH/runtime/mcp.mjs`. The adjacent `daemon.mjs` and viewer assets must remain together. Do not use `npx` or an installation command as the server launch command.

Client configuration locations and schemas vary. The object above is the common `mcpServers` shape, not a claim of qualification for every client/version. Translate it into your client's documented stdio-server configuration if necessary. The adapter tests exercise legacy initialization and the newer discovery/request envelopes; see [compatibility](compatibility.md).

## First safe check

Ask the client to list the available tools and call `ssh_hosts_list` or `ssh_vault_status`. Neither action needs to connect to a target. A configured but unapproved target must still reject `ssh_connection_open` and command/session operations.

For an already approved target, start with `ssh_connection_probe`. Review tool arguments and the target before allowing a write action. Tool annotations describe risk; they do not replace your MCP client's approval controls or the daemon's grants.

## Permissions and secrets

- The adapter reads the local `agent.token` itself. Do not copy bootstrap tokens into MCP configuration or prompts.
- Tool arguments cannot supply an operator identity, secrets, host confirmation or grants.
- `ssh_grants_set`, host-key confirmation, credential mutation and vault unlock are not MCP tools.
- An agent can create an unapproved profile; it cannot thereby authorize a connection.
- `shell` permits arbitrary commands. Treat terminal input and job execution as powerful write operations.
- Credential listings contain references/metadata, never secret values. Target/profile metadata can still be identifying: don't paste it into public issues.

The operation catalog is maintained in [catalog.ts](../packages/ssh-manager-runtime/src/catalog.ts). It is the source of truth for names and annotations; the [security model](security-model.md) describes the trust boundary.

## Sessions and disconnects

Closing the MCP client detaches its authenticated readers/writer and does not stop the daemon. A later client can attach to a still-running daemon-owned terminal, but must obtain its own authenticated writer lease. Losing SSH connectivity or restarting the daemon can lose a plain PTY. Jobs are never automatically replayed. Vault lock keeps established authenticated sessions alive while preventing new vault-based authentication.

If startup fails, build first, check the Node version and state-directory ownership, then use [troubleshooting](troubleshooting.md). Never work around a failure by exposing the loopback API on a public interface.

## Trusted embedding

The configurable [public client/stdio integration](client-integration.md) preserves this catalog and the official SDK transport. Reusable bounded admission is explicitly blocked on the upstream SDK completion hook; standalone invocation remains compatible.
