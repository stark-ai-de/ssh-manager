# @stark-ai/ssh-manager

Canonical TypeScript SSH management built on ssh2. Own host profiles, credentials, host trust, target grants, verified connections, terminal sessions, jobs, SFTP, tunnels and metadata audit without importing HTTP or MCP.

**Early-stage; Node 24.18.0+.** Apache-2.0. Public npm availability is not assumed; build and pack from the [source repository](https://github.com/stark-ai-de/ssh-manager).

- [Embedding and installation](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/library.md)
- [Configuration](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/configuration.md)
- [Security model](https://github.com/stark-ai-de/ssh-manager/blob/main/docs/security-model.md)
- [API contracts](https://github.com/stark-ai-de/ssh-manager/blob/main/packages/ssh-manager/src/public-api.ts)

Use a private state directory with one owner. Your application must authenticate actors and protect operator setup; actor objects are not an untrusted-user authorization mechanism. Host verification and human target grants are mandatory. A shell grant permits arbitrary remote commands. Always shut down your manager deliberately; plain terminals may be lost, and jobs are never replayed on reconnect.

For sharing the existing daemon rather than owning SSH resources, use `@stark-ai/ssh-manager-runtime/client` instead. Security reports: [security@stark-ai.de](mailto:security@stark-ai.de).
