# Library and typed-client integration

Choose an ownership model before writing an integration:

| Need                                                  | Use                                        | State/lifecycle owner |
| ----------------------------------------------------- | ------------------------------------------ | --------------------- |
| Manage SSH directly without HTTP or MCP               | `@stark-ai/ssh-manager`                    | Your application      |
| Share existing daemon connections with CLI/viewer/MCP | Runtime `ManagementClient` / `localClient` | The daemon            |

**Never run an embedder and daemon against the same state directory.** The direct library trusts the embedding application to authenticate users and supply honest actor identities. It is not an authentication boundary for untrusted plugins.

## Install from a local build

Published npm availability is not assumed. From the SSH Manager source checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm pack:check
pnpm --filter './packages/*' -r pack --pack-destination "$PWD/dist/packages"
```

The last command creates tarballs; it does not publish. `pack:check` performs its own temporary pack and inventory checks. In your consumer project, use the actual output filenames. For the library alone:

```sh
pnpm add /ABSOLUTE/PATH/to/stark-ai-ssh-manager-1.0.0.tgz
```

For the runtime, install **both** the library and runtime tarballs. Before registry publication, also add these overrides to the **consumer project's** `pnpm-workspace.yaml` so transitive internal dependencies resolve to the same tarballs instead of a registry version:

```yaml
overrides:
  "@stark-ai/ssh-manager": "file:/ABSOLUTE/PATH/to/stark-ai-ssh-manager-1.0.0.tgz"
  "@stark-ai/ssh-manager-runtime": "file:/ABSOLUTE/PATH/to/stark-ai-ssh-manager-runtime-1.0.0.tgz"
```

```sh
pnpm add /ABSOLUTE/PATH/to/stark-ai-ssh-manager-1.0.0.tgz /ABSOLUTE/PATH/to/stark-ai-ssh-manager-runtime-1.0.0.tgz
```

An MCP-package consumer needs all three tarballs: add its tarball to the install command and an equivalent `@stark-ai/ssh-manager-mcp` override. Preserve any existing consumer workspace settings. `pnpm pack` rewrites `workspace:*` to concrete versions; direct local dependencies alone do not guarantee that pnpm resolves the transitive versions locally. The smoke check tests this exact override pattern. No registry publication is performed.

For daemon/MCP end users, the [standalone runtime bundle](releases.md) avoids managing these package dependencies entirely. Keep generated tarballs and local state out of source control.

## Embed the canonical library

```js
import path from "node:path";
import { SSHManager } from "@stark-ai/ssh-manager";

// Supply a private directory owned only by this application.
const stateDirectory = process.env.APP_SSH_STATE;
if (!stateDirectory || !path.isAbsolute(stateDirectory)) {
  throw new Error("Set APP_SSH_STATE to an absolute private directory.");
}
const manager = new SSHManager({ stateDirectory });
try {
  // This identity must come from your application's authentication boundary.
  const actor = { id: "authenticated-app-client", kind: "agent" };
  console.log(manager.profiles(actor));
} finally {
  manager.shutdown();
}
```

Require and validate `APP_SSH_STATE` before starting your application. Do not derive `kind: "operator"` or an actor ID from untrusted request/tool arguments. Human operator setup must register credentials, independently verify host trust and approve target capabilities before remote operations. Protect setup separately from ordinary users.

The [embedded command helper](../packages/ssh-manager/examples/embedded.mjs) shows job polling, cancellation and guaranteed shutdown. It returns a final job result rather than automatically retrying an unknown command. Shutdown can interrupt work; use a long-lived manager when your application needs sessions to persist across requests.

Public types and domain errors are exported from the package and `@stark-ai/ssh-manager/contracts`; they do not depend on HTTP or MCP. See [public-api.ts](../packages/ssh-manager/src/public-api.ts) for session/job/file/tunnel interfaces and [configuration](configuration.md) for constructor options.

## Share the daemon

```js
import path from "node:path";
import { localClient } from "@stark-ai/ssh-manager-runtime/launcher";

const stateDirectory = process.env.APP_SSH_STATE;
if (!stateDirectory || !path.isAbsolute(stateDirectory)) {
  throw new Error("Set APP_SSH_STATE to an absolute private directory.");
}
const client = await localClient("agent", { stateDirectory });
try {
  const profiles = await client.call("ssh_hosts_list", {});
  console.log(profiles);
} finally {
  await client.close();
}
```

`localClient` starts/reuses the daemon, exchanges the local bootstrap token for an expiring client identity and maintains heartbeats. `close()` detaches that client; it does **not** stop the runtime. Use a persistent client for terminal reader/writer operations rather than creating a new client for each keystroke.

A runnable, explicit-state example is [list-hosts.mjs](../packages/ssh-manager-runtime/examples/list-hosts.mjs):

```sh
node packages/ssh-manager-runtime/examples/list-hosts.mjs /ABSOLUTE/PATH/to/private-state
```

This command can start the local daemon for that directory but does not connect to an SSH target. The direct `ManagementClient` constructor accepts a loopback URL and bootstrap token for integrations that manage discovery themselves. Keep tokens in memory and never embed them in URLs or logs.

## HTTP, streams and events

The runtime exposes authenticated `/v1/` JSON operations and an authenticated `/v1/openapi.json` document generated from the operation catalog. Register at `POST /v1/clients` using a local agent/operator bootstrap token; subsequent requests use the returned client token, not a caller-supplied identity. Prefer the typed client unless you need another language.

Small file calls transfer base64 ranges (up to 64 KiB); `client.download` and `client.upload` support streams, cancellation and progress callbacks. An interrupted upload may leave a partial remote file. `/v1/events` is a WebSocket endpoint: authenticate in the first message, not a URL query parameter. The current runtime OpenAPI document describes these envelopes and routes.

Handle structured `ManagementError` / `APIError` codes. A timeout is not evidence that a command never ran. Output cursors are bounded: a `gap` requires resynchronizing a terminal with an attach snapshot. Avoid logging remote command/output content or identifying profile details without an explicit application policy.

## Verified client embedding

Application-specific lifecycle owners use the additive [management-client integration](client-integration.md). Native authority, admission tickets and persisted receipts remain responsibilities of the host.
