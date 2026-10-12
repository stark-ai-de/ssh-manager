# @stark-ai/ssh-manager-runtime

Authenticated loopback HTTP/WebSocket API, typed client, CLI, background daemon and browser terminal viewer for SSH Manager. The daemon owns SSH resources; attached clients do not each create a separate engine.

**Early-stage; Node 24.18.0+.** Apache-2.0. Build/pack from the [source repository](https://github.com/stark-ai-de/ssh-manager); no published npm version is assumed.

- [First verified connection](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/getting-started.md)
- [Typed-client usage](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/library.md)
- [Operations and lifecycle](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/operations.md)
- [Security model](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/security-model.md)

The `ssh-management` CLI supports `help`, `start`, `viewer`, `stop`, vault password commands and `operator <operation> <JSON-file>`. Complete trusted local setup before remote use. Use an agent bootstrap token for ordinary clients, keep it out of URLs/logs, and do not expose this API publicly. `client.close()` detaches; it does not stop daemon-owned sessions.

The local package depends on `@stark-ai/ssh-manager`; install both local tarballs when working without registry publication. A verified standalone runtime bundle is another distribution option. Security reports: [security@stark-ai.de](mailto:security@stark-ai.de).
