# Your first verified SSH connection

This guide is for a **human operator** using a server and account they are authorized to access. Examples use `server.example.test`, not a live target. Do not run setup through an AI tool or bypass a failed host-key check.

## 1. Build and inspect the CLI

From the repository root, using Node 24.18.0+, pnpm 12.9.1 and `tar` for the package checks:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm validate
node packages/ssh-manager-runtime/dist/cli.js help
```

The commands below use Bash on Linux/macOS/WSL. On Windows PowerShell, invoke the same Node entrypoint, use absolute JSON file paths and use native Windows credentials/state rather than a WSL agent socket. See [compatibility](compatibility.md).

Set a convenience path and create a private, temporary directory **outside the checkout** for setup argument files:

```sh
CLI="$PWD/packages/ssh-manager-runtime/dist/cli.js"
SETUP="$(mktemp -d)"
chmod 700 "$SETUP"
node "$CLI" start
```

`start` prints the loopback URL and state directory, not a token. It starts or reuses the daemon for your OS user. State is durable in the [platform-specific state directory](configuration.md#state-directories), not in `SETUP`. To use a separate environment, pass the same `--state-directory` absolute path on **every** CLI and MCP invocation.

## 2. Register a credential reference

Prefer an existing SSH agent containing only keys you intend this runtime to use. In a trusted local shell, inspect your own agent with `ssh-add -l`; add a key yourself if needed. Never send key bytes or passphrases through MCP.

Create `credential.json` in `SETUP` with your agent's actual socket path (the value of `SSH_AUTH_SOCK` on Unix):

```json
{
  "reference": {
    "kind": "agent",
    "name": "Development SSH agent",
    "socket": "REPLACE_WITH_AGENT_SOCKET"
  }
}
```

```sh
node "$CLI" operator ssh_credential_add "$SETUP/credential.json"
```

Type `ssh_credential_add` at the local confirmation prompt. Save the returned `id` for the next step. This registers a reference; it does not copy keys into the repository or grant target access. The daemon needs access to the agent socket for later authentication.

Alternative: use a `key-file` reference with `name` and an absolute `path` to an existing unencrypted private key. Encrypted key files need an existing vault passphrase reference (`passphraseId`). See [credentials](configuration.md#credentials) for the vault and its current setup limitations. Do not create plaintext credential JSON files as a shortcut.

## 3. Create an unapproved host profile

Create `profile.json`, replacing the host, account and credential ID. Use a narrow SFTP root even though this walkthrough does not yet grant file access:

```json
{
  "profile": {
    "name": "Development server",
    "host": "server.example.test",
    "port": 22,
    "username": "developer",
    "credentialId": "REPLACE_CREDENTIAL_ID",
    "fileRoots": ["/srv/project"]
  }
}
```

```sh
node "$CLI" operator ssh_host_create "$SETUP/profile.json"
```

Keep the returned profile `id` and `revision`. All following `targetId` values mean this **profile ID**, not its display name or hostname. Creating a profile grants nothing.

## 4. Inspect, independently verify, then confirm the host key

Create `target.json`:

```json
{ "targetId": "REPLACE_TARGET_ID" }
```

```sh
node "$CLI" operator ssh_host_inspect "$SETUP/target.json"
```

The result includes `revision`, `key` (base64) and `fingerprint`. Inspection observes the presented key; **it does not prove the server's identity**. Compare its SHA-256 fingerprint using a trusted server console or an independently authenticated administrator. For a server you administer, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256` on its trusted console is one way to inspect that key; the selected key type must match the key presented here.

Only after that independent check, create `confirm.json` with the exact reviewed values:

```json
{
  "targetId": "REPLACE_TARGET_ID",
  "expectedRevision": 1,
  "key": "REPLACE_WITH_REVIEWED_BASE64_KEY",
  "fingerprint": "REPLACE_WITH_REVIEWED_SHA256_FINGERPRINT"
}
```

```sh
node "$CLI" operator ssh_host_confirm "$SETUP/confirm.json"
```

Use the actual reviewed revision, not always `1`. The prompt requires typing the reviewed fingerprint. Never automatically pipe inspection output into confirmation. A conflicting/revoked `known_hosts` entry is not overridden by a new pin; investigate it using [troubleshooting](troubleshooting.md).

## 5. Grant only the capabilities you need

Create `grants.json` for a connection-only probe:

```json
{
  "targetId": "REPLACE_TARGET_ID",
  "expectedRevision": 1,
  "capabilities": ["connect"]
}
```

```sh
node "$CLI" operator ssh_grants_set "$SETUP/grants.json"
node "$CLI" operator ssh_connection_probe "$SETUP/target.json"
```

A successful probe verifies the host and completes authentication without starting a remote command. For the remaining steps, review the account's privileges, change the capabilities to `["connect", "shell"]` and run `ssh_grants_set` again. **`shell` permits arbitrary remote commands**, not just the example below. Changing credentials, endpoint, route or trust can invalidate grants; reread the current revision before granting again.

## 6. Run and inspect a job

For a POSIX target, create `job.json`:

```json
{
  "targetId": "REPLACE_TARGET_ID",
  "command": "printf 'hello from SSH Manager\\n'",
  "timeoutMs": 10000
}
```

```sh
node "$CLI" operator ssh_job_start "$SETUP/job.json"
```

Create `read-job.json` using the returned job ID:

```json
{ "jobId": "REPLACE_JOB_ID", "cursor": 0 }
```

```sh
node "$CLI" operator ssh_job_read "$SETUP/read-job.json"
```

Repeat reads until the state is no longer `running`; advance `cursor` to the returned output cursor to avoid duplicate output. `unknown` means the remote outcome cannot be established. **Do not blindly rerun the job after a timeout or disconnect.** A cancellation does not prove detached remote descendants stopped.

## 7. Open the browser terminal

```sh
node "$CLI" operator ssh_session_create "$SETUP/target.json"
node "$CLI" viewer
```

Open the printed loopback URL yourself. Enter the returned session ID and the local **agent bootstrap token** from `agent.token` in your state directory. Read it privately using a local editor; do not put it in a URL, screenshot, issue, shell command argument or chat. Do not use `operator.token` for the viewer.

Select **Attach terminal**, then **Acquire input** to type. Other clients may read, but only the authenticated writer may send input. **Detach** leaves the daemon-owned terminal running. The viewer keeps tokens in memory rather than browser storage.

Plain terminals can be lost on SSH loss or daemon restart. For a Unix server where tmux is already installed, `ssh_session_create` also accepts `"tmux": true`; recovery remains explicit and conditional. See the [lifecycle diagram](architecture.md#terminal-lifecycle).

## 8. Continue or stop deliberately

- [Configure MCP](mcp.md) with the same state directory.
- [Use the typed client](library.md) to share this daemon.
- Add file or tunnel grants only when required; see [configuration](configuration.md).
- To end a particular session, call `ssh_session_close` with its `sessionId`. A detached remote tmux process may remain.
- To stop the daemon and its connections deliberately, run `node "$CLI" stop`. This can interrupt jobs and lose plain terminals; it does not guarantee remote descendants terminate.

Remove your temporary setup argument files when no longer needed. Do not remove the daemon state directory as cleanup; it holds durable metadata, credentials and trust. [Operations](operations.md) explains backups and uninstall.
