# Security model and limits

This document explains implemented boundaries; it is not an independent security audit or a deployment certification. Report suspected weaknesses through [SECURITY.md](../SECURITY.md).

## What is protected

- **Host identity:** known-hosts entries or explicitly reviewed pins must match. Revoked/changed keys fail closed; host certificates/CA trust are not supported by this version.
- **Human target authority:** remote operations require current revision-bound capabilities. Credential/endpoint/route changes invalidate affected authority. MCP cannot grant itself access.
- **Credential isolation:** MCP receives references and metadata, never secret inputs. The library/runtime resolve SSH-agent, key-file or encrypted-vault credentials locally.
- **Authenticated writer identity:** the runtime assigns client identities. Several readers can attach; input/resize require the client's writer lease. Agents cannot force handoff.
- **Local transport:** loopback binding, bearer authentication, Host/Origin checks, bounded requests and short-lived registered clients limit remote/browser attack paths. Tokens are not URL parameters.
- **Resource containment:** SFTP roots, connection/channel/session/output/transfer limits and schema validation apply across access paths.
- **Distribution integrity:** build/artifact manifests, exact source identity, dependency notices and full-inventory verification support reviewed distribution.

## What is not protected

| Boundary         | Limitation                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Same OS user     | A malicious process running as the owning user may read tokens/key files or inspect the runtime. Agent tool restrictions are not an OS sandbox |
| Direct embedding | The host application supplies trusted `Actor` identities and must authenticate/authorize its own entrypoints                                   |
| Shell access     | `shell` grants arbitrary commands as the remote account. It bypasses the usefulness of SFTP-only path restrictions for containing that account |
| Vault            | Encryption protects stored secret records, not a compromised running process; it is not zero knowledge                                         |
| Target grants    | They are shared target capabilities for the state owner, not tenant-specific RBAC or per-user SSO                                              |
| Audit            | Bounded metadata-only local audit is not tamper-proof, comprehensive command recording or a compliance system                                  |
| Remote output    | Terminal/job/file content is untrusted data and may contain secrets or prompt injection. Do not treat it as instructions                       |
| Continuity       | Plain PTYs can be lost; tmux recovery is conditional. Unknown job outcomes cannot be repaired by silent replay                                 |
| Artifact hashes  | Hashes need a trusted external pin; a self-consistent malicious bundle can carry its own matching manifest                                     |

## Operational safeguards

Use least-privilege remote accounts, narrow grants, separate state for independent owners and trusted local setup. Do not give an AI unrestricted local filesystem/shell access to operator tokens while relying on the MCP tool boundary to constrain it. Never expose the management API publicly with an ad-hoc reverse proxy.

Vault lock leaves existing authenticated sessions alive. Explicitly close connections/stop the service when access must end, understanding that detached remote processes may survive. Terminal recording is opt-in and pauses on lock; do not claim an uninterrupted transcript.

Backups contain identifying metadata and encrypted secrets and require protection. Review screenshots and bug reports for host data, paths and tokens. Dependency checks and CodeQL are useful signals, not substitutes for security review. [Operations](operations.md) and [configuration](configuration.md) describe practical setup.
