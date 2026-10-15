# Bounded reusable MCP on the published SDK

The SSH Manager owns reusable admission on the unchanged, published `@modelcontextprotocol/server` **2.3.1**. No change, merge, release or decision in an externally owned repository is needed to build or operate this implementation. The existing exact dependency and lockfile remain unchanged.

## Optional upstream proposal

[Official TypeScript SDK PR #3024](https://github.com/modelcontextprotocol/typescript-sdk/pull/3024) proposes public inbound-processing completion hooks. It is an **optional simplification opportunity, not a runtime, build, delivery or qualification dependency**. On 2026-10-15 it remains open and Draft. We cannot predict whether or when it will merge, or whether its final form will preserve the proposed semantics.

If the proposal is merged substantially in this form and appears in a reviewed SDK release, its hooks may replace parts of this adapter. Such adoption requires checking actual handler, write, cancellation, error and subscription cleanup and rerunning the same tests. Until then the implementation below is complete within its documented published-SDK contract; it does not contain a local SDK patch, fork, private-field access or a second MCP implementation.

## Ownership and limits

[stdio.ts](../packages/ssh-manager-mcp/src/stdio.ts) owns admission, input rate/bytes, output queue/bytes, handler and factory tails, work scheduling, subscriptions and client cleanup. Defaults are eight active requests, sixteen held messages, two ordinary calls, eight waiting calls, at most two clients/factories, 1 MiB input, 64 input messages per second, 64 MiB per output and 96 MiB/sixteen queued outputs. Every required policy field is validated before I/O. `usage()` returns bounded ownership counts without request IDs, credentials or call data. There is no request-count lifetime or ten-minute expiration.

[server.ts](../packages/ssh-manager-mcp/src/server.ts) keeps the single canonical catalog loop and official `McpServer.registerTool` validation. It decorates the public `setRequestHandler` registration method before tools are registered. This observes the whole handler, including invalid tool/input handling, application policy, physical invocation and output validation. The SDK itself declares the tools capability on first registration. No copied tool list or management-client subclass is introduced.

[stdio-transport.ts](../packages/ssh-manager-mcp/src/stdio-transport.ts) keeps official `StdioServerTransport` framing and input decoding. A Node Writable adapter joins the actual output callback, including backpressure. Direct sends are serialized so each promise owns its own callback. A public Node `finished` observer is attached before any write and joins actual asynchronous stream destruction after failure, including stdout configurations that do not emit a close event; a destroy request, deferred error or elapsed turn cannot replace that completion. A failed stream without observable completion keeps shutdown pending. Healthy process stdout is never ended or destroyed by normal close.

## Completion proof for SDK 2.3.1

The official stdio entry has no public completion callback. The provider therefore submits one new entry at a time and joins factory construction, actual output and discovery-handler work before an event-loop checkpoint. Its bounded queue keeps the SDK's internal entry pump from acquiring an unobserved backlog. Ordinary tool handlers may continue concurrently up to their configured limit.

The audited SDK has only finite promise continuations between these observed boundaries and internal bookkeeping cleanup. `setImmediate` drains those continuations **after** real owned tails; it is not a timer-based cleanup inference. A record can be released only after actual entry dispatch, complete registered handler settlement, every associated write and that checkpoint. A received response or cancellation is insufficient. Cancelled handlers that still own physical work retain their IDs and credits. Requests rejected before a tool handler, including malformed envelopes and unknown methods, still pass through the audited entry and write barriers.

The audited implementation paths are the published SDK's `stdio.mjs` (`serveStdio`, connection channels and opening/probe handling), `mcp-DIH4cS6P.mjs` (`McpServer`, role handlers and listen router) and `src-Cqbh3MYc.mjs` (protocol dispatch, encoding and final cleanup). [The bundle builder](../scripts/lib/ssh-runtime-bundle.mjs) verifies their exact digests and package version before producing artifacts. Its guard detects changed bytes; the proof also depends on the source review and regressions below.

In this fixed configuration, builtin initialize/ping/discover and cancellation have no unobserved I/O. The canonical server has no asynchronous initialized callback, fallback handler, custom context builder, request-state verifier, reverse requests or multi-round-trip tools. New uses of those facilities, alternate server factories, dependency overrides or SDK upgrades require a fresh lifecycle review. Do not bypass the digest check or introduce a local SDK patch. The usual frozen lockfile, exact package dependency, Node runtime and artifact integrity requirements still apply.

An acknowledged modern `subscriptions/listen` retains its request ID. Cancellation releases it only after the entry actually applied the router cancellation and all prior ACK/fanout writes completed. Graceful shutdown joins terminal subscription writes and SDK close. Client cleanup failures remain charged and reject close. Closing denies new work synchronously, joins all handler/factory/output/client tails and returns one stable promise.

## Validation boundaries

The real published-SDK [stdio regressions](../packages/ssh-manager-mcp/test/stdio-integration.test.mjs) exercise both protocol generations, the complete canonical tool list, thousands of completed requests and ID reuse, eight cancelled held handlers, ninth-request denial, invalid requests, input/output budgets, late factories, asynchronous policy, unresolved cleanup, held callbacks, failed asynchronous stream destruction and subscription ACK/cancel/close. They run through the official decoder and actual Node streams; separate custom-transport cases cover embedding boundaries.

`pnpm test:mcp:duration` runs both generations for at least 602 seconds, repeatedly reusing eight request IDs and checking zero remaining request/message/handler/output ownership after each completed batch, one surviving client and the full tool catalog. Its invocation supplies canonical fixture data. This is provider MCP evidence; it does not qualify Mechas native receipts, real SSH authority, signed helpers or a final desktop package. See [validation](validation.md) for the aggregate and separate native gates.
