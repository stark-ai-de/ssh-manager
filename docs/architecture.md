# Architecture

The library owns SSH management behavior and exposes independent TypeScript types, domain errors and lifecycle contracts. It uses ssh2 for SSH and Node crypto for the credential vault. It does not depend on Fastify or MCP.

The local runtime embeds the library, owns long-lived connections and terminal sessions, and provides authenticated versioned HTTP/WebSocket operations. The MCP adapter uses ManagementClient and starts the runtime on demand; terminating the MCP client does not end server-owned sessions.

Host profiles, credentials, explicit host trust and human target grants are shared policy. Changes to endpoint, credentials or route invalidate affected grants and connections. Arbitrary shell execution is a powerful write capability. Agent tool arguments cannot supply credentials, grant privileges or impersonate an operator.

One OS user owns each native state directory. Applications can embed the library with an independent lifecycle/state or share the runtime through its typed client. Simultaneous embedders must not own the same state directory.

Source ownership is independent of the Skills plugin repository. That repository consumes pinned generated artifacts. Mechas is a possible client, not a required runtime dependency.
