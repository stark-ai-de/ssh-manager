# Configuration reference

The contracts in [contracts.ts](../packages/ssh-manager/src/contracts.ts), [manager.ts](../packages/ssh-manager/src/manager.ts) and the runtime [catalog](../packages/ssh-manager-runtime/src/catalog.ts) are canonical. There is no separate YAML daemon configuration file or undocumented environment-based permission override.

## State directories

| Native runtime | Default location                                                             |
| -------------- | ---------------------------------------------------------------------------- |
| Linux / WSL    | `${XDG_STATE_HOME:-$HOME/.local/state}/stark-ai/ssh-manager`                 |
| macOS          | `$HOME/Library/Application Support/stark-ai/ssh-manager`                     |
| Windows        | `%LOCALAPPDATA%\stark-ai\ssh-manager` (fallback: the user's `AppData\Local`) |

CLI and MCP accept `--state-directory <absolute-native-path>`. Use one owner per directory. WSL and native Windows are separate environments: do not share a live state directory or assume their agent sockets are interchangeable.

State contains profiles, credential references, grants, trust pins, session metadata, audit, vault ciphertext, ownership markers and local authentication tokens. Do not commit, sync publicly, or upload it to a support issue. On Unix the runtime restricts directory/file modes; on Windows protect the directory with your user ACLs. The runtime cannot isolate malicious processes already running as the same OS user.

## Host profiles

| Field                      | Meaning / default                                                              |
| -------------------------- | ------------------------------------------------------------------------------ |
| `name`, `host`, `username` | Required label, endpoint and remote account                                    |
| `port`                     | SSH port, default `22`                                                         |
| `credentialId`             | Existing operator-registered credential reference                              |
| `groups`                   | Up to 32 identifier labels; default empty                                      |
| `shell`                    | `posix` (default), `powershell`, or `cmd`                                      |
| `jumpIds`                  | Ordered approved jump profile IDs, up to four; default empty                   |
| `proxy`                    | Optional `socks5` or `http-connect` endpoint and optional credential reference |
| `fileRoots`                | Canonical absolute SFTP roots, up to 16; **default `["/"]`**                   |

Set narrow file roots explicitly before granting file access. File-root restrictions are not a sandbox for shell commands. Windows target SFTP paths depend on the server's SFTP namespace; do not assume a drive-letter path satisfies the canonical root contract.

Profile IDs are distinct from names. Updates carry `expectedRevision`; stale edits fail instead of silently overwriting state. Endpoint/credential/route and other sensitive changes invalidate affected grants/connections. Reread the current profile and review it again before regranting.

SSH config import is deliberately partial: preview supported aliases/HostName/User/Port, review warnings, then apply. It never executes `ProxyCommand`, expands `Include`, reads private keys, or imports trust/grants. `IdentityFile` and `ProxyJump` need explicit credential/target references afterwards.

## Credentials

| Kind       | What is stored                                            | Authentication requirement                                           |
| ---------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `agent`    | Name and socket reference                                 | A reachable agent with an appropriate loaded key                     |
| `key-file` | Name, absolute key path and optional vault `passphraseId` | The file must remain readable; an encrypted key needs its passphrase |
| `vault`    | Reference metadata; secret bytes encrypted locally        | Initialized/unlocked vault for new authentication                    |

The vault supports password, private-key and passphrase records. `vault-init`, `vault-unlock` and `vault-rotate` prompt interactively without echoing passwords. `vault-lock` clears vault decryption availability but **does not terminate authenticated sessions**.

Credential creation/update is operator-only. The generic operator API accepts secret material for trusted integrations, but the generic CLI reads its arguments from a JSON file; it is **not** a secret-entry wizard. Prefer agent/key-file references for the walkthrough. If building a vault setup UI, prompt privately, pass secrets directly to the authenticated operator API, avoid disk/log persistence and clear references afterwards. Do not put real secret values into JSON examples, command-line arguments or MCP configuration.

## Capabilities

Every target capability set needs `connect` for remote access:

| Capability    | Allows                                             |
| ------------- | -------------------------------------------------- |
| `connect`     | Verified SSH authentication and connection reuse   |
| `shell`       | Jobs and PTYs, including arbitrary remote commands |
| `files.read`  | SFTP reads/metadata within configured roots        |
| `files.write` | SFTP mutation within configured roots              |
| `tunnel`      | Local/remote forwarding and SOCKS CONNECT tunnels  |

Grants are human-reviewed and bound to a profile revision. They authorize access to that target for authenticated clients of this state owner, **not per-human multi-tenant RBAC**. Operator-only actions remain separate. A profile without a current grant cannot connect even with a valid credential and trusted host key.

## Resource limits

Embedders may set `ManagerOptions.limits`. The standalone CLI uses the library defaults; it does not expose every constructor option as a flag.

| Limit                                 |       Default |         Maximum |
| ------------------------------------- | ------------: | --------------: |
| Connections / per target              |        16 / 3 |        128 / 16 |
| Channels per connection / waiters     |        8 / 32 |        64 / 256 |
| Authentication / channel timeout (ms) | 20000 / 15000 | 300000 / 300000 |
| Idle timeout (ms)                     |        600000 |        86400000 |
| Sessions / retained jobs              |       16 / 32 |        64 / 128 |
| Concurrent transfers / tunnels        |        4 / 16 |         32 / 64 |
| Retained output bytes                 |       1048576 |         8388608 |
| File bytes per transfer               |     104857600 |      1073741824 |

Limits must be positive safe integers. Output retention is bounded; it is not a complete persistent transcript. Audit is metadata-only by default. Terminal recording is opt-in, encrypted in the vault and pauses while the vault is locked.

The local API binds `127.0.0.1` on an automatically chosen port by default. It authenticates clients and checks Host/Origin. Do not reverse-proxy it onto a network interface as a substitute for a designed remote-authentication model.
