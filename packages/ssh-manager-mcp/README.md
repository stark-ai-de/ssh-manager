# @stark-ai/ssh-manager-mcp

Individual SSH management tools over MCP stdio. This adapter calls the authenticated local runtime, starts it on demand, and never owns a separate SSH engine or installs dependencies at startup.

**Early-stage; Node 24.18.0+.** Apache-2.0. Build/pack from the [source repository](https://github.com/stark-ai-de/ssh-manager); no published npm version is assumed.

- [MCP configuration](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/mcp.md)
- [Trusted operator setup](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/getting-started.md)
- [Compatibility](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/compatibility.md)
- [Security model](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/security-model.md)

Launch the built `dist/main.js` with Node, optionally passing `--state-directory` and an absolute private directory. The `ssh-management-mcp` bin is available when the package is installed. Keep stdout reserved for protocol traffic.

MCP cannot supply secrets, confirm host keys, grant capabilities or impersonate an operator. Complete setup locally; unapproved targets cannot connect. Terminating the MCP client detaches it but does not terminate the daemon. Jobs are never automatically replayed, and lost plain PTYs cannot be resumed by reconnecting.

Local package installation requires the matching library and runtime packages too; the standalone verified runtime bundle avoids registry dependencies at startup. Security reports: [security@stark-ai.de](mailto:security@stark-ai.de).
