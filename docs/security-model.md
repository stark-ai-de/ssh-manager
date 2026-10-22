# Security model and limits

This document explains implemented boundaries; it is not an independent security audit or a deployment certification. Report suspected weaknesses through [SECURITY.md](../SECURITY.md).

## What is protected

- **Host identity:** known-hosts entries or explicitly reviewed pins must match. Revoked/changed keys fail closed; host certificates/CA trust are not supported by this version.
- **Human target authority:** remote operations require current revision-bound capabilities. Credential/endpoint/route changes invalidate affected authority. MCP cannot grant itself access.
- **Credential isolation:** MCP receives references and metadata, never secret inputs. The library/runtime resolve SSH-agent, key-file or encrypted-vault credentials locally.
- **Authenticated writer identity:** the runtime assigns client identities. Several readers can attach; input/resize require the client's writer lease. Agents cannot force handoff.
- **Local transport:** loopback binding, bearer authentication, Host/Origin checks, bounded requests and short-lived registered clients limit remote/browser attack paths. Tokens are not URL parameters.
- **Resource containment:** SFTP roots, connection/channel/session/output/transfer limits and schema validation apply across access paths.

The direct library exposes an explicit operator-only `files.startDirectory` discovery operation.
It requires the current target's `connect` grant, host verification and authentication, opens a
bounded SFTP channel and returns only its canonical absolute `REALPATH .` result. It does not
list/read files, change grants/roots, execute a shell, or write remote data. The returned path
is a proposal for human review, not file authority or proof of directory ownership/permissions.
Agents and HTTP/MCP callers have no discovery endpoint. Embedders must bind operator identity
and the explicit user action themselves. Windows paths use the server's SFTP namespace, not a
derived local home path.

An explicitly empty `fileRoots: []` is a deny-all file policy. It allows connect-only
setup and start-directory discovery before a human selects a root. The existing default
for omitted `fileRoots` remains unchanged; embedders that require deliberate path approval
must supply the empty set explicitly. Granting file capabilities does not override it.

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

## Narrowed file operations for embedders

Target grants and profile roots are shared by the state owner. A trusted embedder can additionally pass an optional `FileScope` to individual canonical SFTP operations: `roots` is a maximum of 16 canonical absolute paths; `[]` denies all paths. The Core intersects these roots with the existing profile roots for both the lexical request and resolved target (including a create destination's parent). Both source and destination of rename are checked. When resolving a create destination fails, a separate no-follow leaf check must prove the leaf is missing before falling back to its resolved parent; an existing dangling symlink is denied. Broadening a scope cannot expand profile roots or missing file grants. Omitted scope retains the existing API behavior.

`list` and `stat` append scope after the optional signal; `read` appends it after its existing signal. `mutate`, `upload` and `download` accept `scope` in their options. Roots are validated and copied before the first asynchronous operation, so later mutation of the caller's array does not widen an in-flight request. This is an ephemeral restriction, not persisted authority or a workspace model. The embedder must authenticate its callers and supply the scope from trusted policy; passing untrusted user roots does not establish isolation.

SFTP realpath followed by another operation remains subject to remote filesystem replacement races; this API is not an atomic open-by-handle sandbox and does not provide stable remote file identity. It cannot constrain arbitrary shell commands or a malicious remote server. Start-directory discovery still returns only path metadata and grants no file access. No HTTP/MCP endpoint or transport permission is added by this direct library argument.

## Vault KDF runtime compatibility

Vault schema 1 retains Argon2id v1.3 with 65536 KiB memory, three passes, four lanes,
a 16-byte salt and a 32-byte derived key. Native `node:crypto.argon2` remains the first
backend. Only `ERR_CRYPTO_ARGON2_NOT_SUPPORTED` selects pinned `hash-wasm` 4.12.0;
Electron/BoringSSL exposes the Node API but reports this capability failure at execution.
The WebAssembly backend computes the same Argon2id bytes with the same parameters.
There is no password retry, weaker KDF, format conversion, new endpoint or authority.
All other native errors propagate; incorrect passwords still fail authenticated vault opening.

The fallback is local and bundled; it does not fetch code or use another Node process.
Its calculation runs on the owning JavaScript thread and temporarily uses at least the
64 MiB Argon2 working memory. Embedders must qualify latency/memory on their actual
runtime and preserve their existing admission bounds. Owned password/result byte buffers
are cleared in `finally`; JavaScript strings, library-internal/WASM memory and garbage
collection do not provide a guarantee of immediate complete memory erasure. The runtime
remains outside the same-user process-inspection threat boundary described above.
