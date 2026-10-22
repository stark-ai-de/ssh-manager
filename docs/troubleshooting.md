# Troubleshooting

Start with Node 24.18.0+, the current build and the **same state directory** on CLI/MCP/viewer paths. Do not disable host verification, manually edit grants or delete state to get past an error.

| Symptom / code                          | Meaning                                                                                            | Safe next step                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `FORBIDDEN`                             | No current capability grant, or an operator-only operation was attempted as an agent               | Human reviews the current profile revision and grants only needed capabilities; setup stays outside MCP                       |
| `HOST_KEY_UNKNOWN`                      | No acceptable known host entry or reviewed pin                                                     | Inspect, verify through an independent trusted channel, then confirm locally                                                  |
| `HOST_KEY_CHANGED` / `HOST_KEY_REVOKED` | Host identity differs or was explicitly revoked                                                    | Stop; investigate with the server owner. A pin must not override conflicting/revoked trust                                    |
| `UNSUPPORTED_HOST_CA`                   | Host certificates are outside the current trust contract                                           | Use a supported deployment or another client; don't disable verification                                                      |
| `VAULT_LOCKED`                          | New authentication needs a vault secret                                                            | Unlock in a trusted local interactive terminal; established sessions can still work                                           |
| `CONFLICT`                              | An expected revision is stale                                                                      | Reload, inspect changes and review again; don't guess a new revision                                                          |
| `STATE_BUSY`                            | Another manager/daemon owns this state                                                             | Use the runtime client or an independent directory, not a second owner                                                        |
| `STATE_VERSION` / `STATE_CORRUPT`       | Unsupported or invalid persisted state                                                             | Preserve bytes, stop competing processes deliberately and consult upgrade/backup guidance                                     |
| `RUNTIME_START_FAILED`                  | Daemon did not become ready                                                                        | Check Node/build, native path permissions and ownership markers; don't remove a marker without establishing the owner is gone |
| `WRITER_REQUIRED` / another writer      | This client lacks the session input lease                                                          | Attach and acquire input; agents cannot force another writer out                                                              |
| `PATH_DENIED`                           | SFTP path is outside allowed roots or unsafe                                                       | Review canonical remote paths and roots locally; don't grant `/` as a reflex                                                  |
| `TMUX_UNAVAILABLE`                      | tmux or the prior remote session is absent                                                         | Treat the old session as unavailable. The runtime never installs tmux automatically                                           |
| `PORT_UNAVAILABLE`                      | Requested tunnel port is occupied                                                                  | Choose an approved unused port (or local port `0` where applicable)                                                           |
| `CONNECTION_FAILED`                     | The target port refused the connection, the name did not resolve or the socket closed before login | Check host, port, network and that sshd runs; credentials were not the cause                                                  |
| `TIMEOUT` (connect)                     | The SSH handshake or login did not finish within the authentication limit                          | Check reachability and server load; nothing is retried automatically                                                          |
| `INVALID_CREDENTIAL`                    | Private-key data is malformed, public-only, or cannot be decrypted with the supplied passphrase    | Review the private key and its passphrase through trusted local setup; do not share secret data or retry automatically        |
| `AUTHENTICATION_FAILED`                 | The server rejected the offered credential, or the handshake failed after the connection opened    | Review the assigned credential locally; do not loop retries against the server                                                |
| `CANCELLED_OR_TIMEOUT` / job `unknown`  | A request was interrupted; remote outcome may be unknown                                           | Investigate before rerunning; retries can duplicate side effects                                                              |

## Viewer connects but typing does not work

Use the exact printed loopback origin, an agent bootstrap token and a valid session ID. Attach, then acquire input. Another authenticated client may hold the writer lease. Browser/MCP exit detaches; it does not necessarily close the terminal. If the session is `lost`, reconnecting the viewer cannot resurrect its plain PTY.

## MCP server is missing or exits

Build first, use an absolute entrypoint and Node executable if the client has a limited PATH, and keep bundle assets together. Protocol traffic must be the only stdout output; inspect stderr privately. Confirm the host is configured as a stdio MCP server. Do not add dependency installation to the launch command.

## Prepare a useful report

Use synthetic fixtures where possible. Record package/source revision, OS, Node/pnpm versions, access path, error code and steps. `ssh_diagnose` can help locally, but its metadata can identify targets: redact before sharing. Never upload `state.json`, token files, vault files or unredacted recordings. See [support](../SUPPORT.md) and [security reporting](../SECURITY.md).
