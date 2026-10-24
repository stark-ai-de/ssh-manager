# Operations and compatibility

Use Node 24.18 or newer. The local API binds loopback, authenticates clients and validates browser origins/hosts. Windows and WSL maintain separate native state.

Trusted local setup registers credentials, host trust and target capabilities. MCP receives references/status, never secret inputs. SSH-agent, private-key file references and an encrypted local vault are supported. Vault encryption protects stored data; the running SSH process can use decrypted credentials and is not zero knowledge.

Terminals permit multiple readers and one controlled authenticated writer. Viewer or MCP exit detaches clients. Plain PTYs may be lost on SSH loss or daemon restart. Optional pre-existing tmux on suitable Unix targets permits reattachment; it is never automatically installed. Target reboot normally loses both. Reconnect never reruns jobs; unknown outcomes remain distinguishable.

Local and SOCKS tunnel setup reserves the chosen loopback listener before opening a new SSH transport, so that transport cannot take the listener port as its own ephemeral source port. A reserved listener is not ready: clients arriving before setup completes are closed without forwarding traffic. Cancellation, target-authority changes and shutdown release pending reservations. Closing a tunnel during setup cancels that attempt; reconnect while it is still settling reports `CONFLICT`. A conflicting listener remains an error, with no port substitution or takeover. Closing an in-flight automatic reconnect keeps the tunnel closed and does not schedule it again. Cancellation after a successful remote-forward reply discards its SSH transport so the remote listener cannot remain accepted as running.

Audit defaults to metadata, terminal recording is disabled by default. Vault locking preserves current sessions but prevents new vault-based authentication. Close connections or stop the service explicitly when desired.

Code migration does not migrate credentials, change state format or restart services. Existing daemons can continue using their loaded implementation. A later installation switch should drain or intentionally end sessions before restarting; normal PTYs are not guaranteed to survive. State downgrade compatibility must be requalified before a release changes that format.

The supplied implementation includes profiles/groups, credentials, trust/grants, connections, direct/jump/proxy routes, PTYs, jobs, SFTP, tunnels and resource/audit controls. Native platform and publication qualification is recorded separately from these implemented capabilities.

## Back up and restore deliberately

- Keep backups outside the source checkout with restrictive permissions/access controls. Even encrypted backups include sensitive metadata.
- The operator-only `ssh_vault_backup` operation exports ciphertext; it is not a complete backup of profiles, grants, trust or referenced key files.
- For a consistent whole-state backup, arrange downtime, inspect running sessions/jobs, deliberately stop the daemon, and copy the private state directory to protected storage. Separately protect referenced key files; an SSH-agent socket is not a persistent credential backup.
- Preserve the vault password using your own secure recovery process. There is no password reset that decrypts a forgotten vault password.
- `ssh_vault_restore` verifies a supplied encrypted document/password and keeps a local recovery backup. Use trusted local operator tooling; do not place passwords in command arguments or public JSON files.
- Test restoration into an independent private directory while no process owns it. Do not start two owners against the same state. A backup does not preserve a running PTY or prove a remote job's outcome.

## Upgrade and roll back

1. Read the [changelog](../CHANGELOG.md), [compatibility](compatibility.md) and candidate release notes. Do not assume state downgrade compatibility.
2. Build/verify the candidate without switching the running daemon. [Verify artifact bytes](releases.md#verify-a-runtime-bundle) against a separately trusted manifest digest and source revision.
3. Back up private state and record the current binary/source revision. Review active jobs, connections, terminals and tunnels.
4. Drain or intentionally end work, then stop the old daemon explicitly. A vault lock is not a stop operation.
5. Start the new installation with the intended state directory and reattach only where the actual lifecycle permits it. Check status before starting new commands.
6. If rollback is necessary, stop the new owner first. Use the preserved binary and a known-compatible backup; do not run old code against a migrated state format without qualification.

Do not restore revoked trust or stale grants as a shortcut. After any restore, review credentials, trust, target revisions and capabilities before reconnecting. Rolling back code never undoes a remote command.

## Uninstall

Remove the MCP entry from your client configuration, then deliberately stop the daemon using the same state directory. Detaching the MCP client alone does not stop it. Remove only the installation directory/packages you chose to uninstall.

Private state is retained unless you explicitly choose to delete it after a protected backup. Removing source/build files does not revoke remote keys, kill detached remote processes or remove remote tmux sessions. Handle those actions separately with the server owner's authorization. Do not use a broad deletion command against an inferred state path.

See [configuration](configuration.md) for state locations and [troubleshooting](troubleshooting.md) for safe error handling.
