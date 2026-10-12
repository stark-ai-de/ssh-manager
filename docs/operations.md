# Operations and compatibility

Use Node 24.18 or newer. The local API binds loopback, authenticates clients and validates browser origins/hosts. Windows and WSL maintain separate native state.

Trusted local setup registers credentials, host trust and target capabilities. MCP receives references/status, never secret inputs. SSH-agent, private-key file references and an encrypted local vault are supported. Vault encryption protects stored data; the running SSH process can use decrypted credentials and is not zero knowledge.

Terminals permit multiple readers and one controlled authenticated writer. Viewer or MCP exit detaches clients. Plain PTYs may be lost on SSH loss or daemon restart. Optional pre-existing tmux on suitable Unix targets permits reattachment; it is never automatically installed. Target reboot normally loses both. Reconnect never reruns jobs; unknown outcomes remain distinguishable.

Audit defaults to metadata, terminal recording is disabled by default. Vault locking preserves current sessions but prevents new vault-based authentication. Close connections or stop the service explicitly when desired.

Code migration does not migrate credentials, change state format or restart services. Existing daemons can continue using their loaded implementation. A later installation switch should drain or intentionally end sessions before restarting; normal PTYs are not guaranteed to survive. State downgrade compatibility must be requalified before a release changes that format.

The supplied implementation includes profiles/groups, credentials, trust/grants, connections, direct/jump/proxy routes, PTYs, jobs, SFTP, tunnels and resource/audit controls. Native platform and publication qualification is recorded separately from these implemented capabilities.
