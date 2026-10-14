# Verified management-client integration

`ManagementClient` remains the canonical HTTP client. Its optional third constructor argument and per-call options allow a trusted host to verify and enroll each actual exchange without replacing fetch, subclassing the client, copying the operation catalog or implementing another transport.

## Actual exchanges and authority

`createClientTransport()` opens a fresh loopback HTTP connection for each exchange. `authority.assertCurrent()` guards construction and response publication; asynchronous `beforeConnect`, `beforeSend(socket)` and `afterResponse(socket)` belong to the host. `sent()` runs synchronously immediately before the first potentially effective write. Sent failures invoke `invalidate()` once. These hooks do not constitute native verification by themselves.

`onExchange(exchange, authority)` runs before body traversal or asynchronous network work. `isClientExchangeForTransport(transport, exchange)` checks exact origin; copies and exchanges from another transport fail. It is not an admission ticket, receipt or proof of completion. The host binds the genuine exchange to its own admission owner. `result` may reject early on cancellation; `settled` waits for owned authority work, decoder, upload/download and the socket's actual close. Neither `destroy()`, a timeout nor the caller result refunds physical capacity.

Per-call `authority`, including explicit heartbeat and close options, avoids shared mutable request context. Late-registration cleanup retains its original authority even if a close option proposes another. `capacity: { ordinary, control }` counts exchanges until physical settlement. The control class contains only authenticated heartbeat and own-client detach. Registration and session detach remain ordinary. No generic operation can borrow a control slot.

## Registration and close

The registration response is validated for actual actor ID, kind, token and lifetime before `onRegistered`. `registration` exposes ID/kind/lifetime without the private token. With `retainSentRegistration`, caller cancellation stops unsent work but keeps a sent response continuation private. `onRegistered` receives `{ publish: false }` when the caller abandoned the registration. Close waits for its physical tail, then sends one own detach using that original authority. The host must keep the original admission ticket and transfer cleanup ownership before making an actor visible. The finite registration deadline can still leave an unknown effect; this option does not promise remote cleanup.

`close({ authority })` denies synchronously and returns the same completion promise on repeated calls. `strictLifecycle` prevents reconnecting an invalidated/closed client; `strictCleanup` reports unresolved detach rather than claiming success. Failed strict cleanup retains private unresolved state. Defaults retain legacy explicit reconnect and best-effort close. Native/receipt revocation remains irreversible and prevents further authorized sends.

## Bounded I/O

The transport counts JSON bytes before serialization, rejects accessors/cycles/non-JSON values, rejects compressed/redirected responses, decodes UTF-8 strictly and bounds cumulative chunks before parsing. Ordinary JSON requests are 1 MiB; catalog-flagged operator requests are 16 MiB and vault restore 48 MiB. Ordinary responses are 16 MiB, backup 48 MiB; registration/control/all errors are 16 KiB. Upload/download streams are 100 MiB with backpressure and actual stream-close joins. These are payload bounds, not a total-heap claim.

## Configurable canonical MCP entry

`@stark-ai/ssh-manager-mcp/stdio` exports `serveManagementStdio({ createClient, beforeCall, admission, input, output })`. The trusted factory owns bootstrap/endpoint discovery. The entry preserves the canonical non-operator tool registry, schemas, annotations and official SDK transport. `beforeCall` can impose application policy without removing tools or granting operator authority. Agent registration is checked before calls. There is no request-count lifetime or ten-minute expiration.

Reusable `admission: { maxRequests: 8, maxMessages: 16 }` requires the public SDK inbound-processing completion capability. The current pinned SDK 2.3.1 lacks that hook: strict admission fails before input starts. The upstream SDK proposal must be accepted and released before this mode can ship; no local dependency patch or fallback is supplied. IDs/credits remain held through cancellation, handlers, writes and subscription teardown. Hosts may configure finite per-message/rate and queued-output policies; a supplied custom transport must also bound raw input before parsing. MCP client/factory ownership is capped at two. Cleanup errors keep uncertain client ownership charged and reject close.
