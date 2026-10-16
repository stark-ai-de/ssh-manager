import * as sdk from "@modelcontextprotocol/server/stdio";
import type { Transport, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/server";
import { APIError, ManagementClient, clientJsonBytes } from "@stark-ai/ssh-manager-runtime/client";
import type { McpIntegrationOptions } from "./server.js";
import { createMcpServer } from "./server.js";
import { createManagementStdioTransport } from "./stdio-transport.js";
export { createManagementStdioTransport } from "./stdio-transport.js";

// Owned here on the published, audited SDK 2.3.1. No unreleased SDK hook.
export const supportsReusableManagementStdio = true;

export interface ManagementStdioOptions {
  /** Trusted embedding owns endpoint discovery and bootstrap provenance. No launcher fallback. */
  createClient: () => ManagementClient | Promise<ManagementClient>;
  transport?: Transport;
  legacy?: "serve" | "reject";
  maxSubscriptions?: number;
  /** Reusable concurrent admission; defaults to eight requests / sixteen messages. */
  admission?: { maxRequests: number; maxMessages: number };
  onerror?: () => void | Promise<void>;
  beforeCall?: McpIntegrationOptions["beforeCall"];
  invoke?: McpIntegrationOptions["invoke"];
  /** Embedding joins its real owned client cleanup instead of bypassing native authority. */
  closeClient?: (client: ManagementClient) => Promise<void>;
  /** Finite queue, with capacity held through the actual invocation promise. */
  work?: { maxCalls: number; maxWaiting: number };
  input?: { messageBytes: number; maxMessages: number; windowMs: number };
  output?: { messageBytes: number; queuedBytes: number; maxMessages: number };
}
export interface ManagementStdioHandle {
  close(): Promise<void>;
  /** Counts only; no actor credentials, request IDs or invocation data. */
  usage(): Readonly<{
    requests: number;
    messages: number;
    handlers: number;
    queuedMessages: number;
    clients: number;
    factories: number;
    calls: number;
    waitingCalls: number;
    outputMessages: number;
    outputBytes: number;
  }>;
}

export function serveManagementStdio(options: ManagementStdioOptions): ManagementStdioHandle {
  const admission = options.admission ?? { maxRequests: 8, maxMessages: 16 };
  for (const value of [admission.maxRequests, admission.maxMessages])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new APIError("INVALID_ARGUMENT", "Invalid MCP admission policy.");
  const maxSubscriptions = options.maxSubscriptions ?? admission.maxRequests;
  if (!Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 0)
    throw new APIError("INVALID_ARGUMENT", "Invalid MCP subscription policy.");
  const wire = options.transport ?? createManagementStdioTransport();
  const clients = new Map<ManagementClient, Promise<void> | undefined>();
  const factories = new Set<Promise<unknown>>();
  type Inbound = {
    message: JSONRPCMessage;
    extra?: MessageExtraInfo;
    entered: boolean;
    handlers: number;
    handlerTail?: Promise<unknown>;
    writes: number;
    subscription: boolean;
    checkpoint?: NodeJS.Immediate;
  };
  const requests = new Map<string | number, Inbound>();
  const records = new Set<Inbound>();
  const queue: Inbound[] = [];
  const handlerTails = new Set<Promise<unknown>>();
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const output = options.output ?? {
    messageBytes: 67108864,
    queuedBytes: 100663296,
    maxMessages: 16,
  };
  for (const value of [output.messageBytes, output.queuedBytes, output.maxMessages])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new APIError("INVALID_ARGUMENT", "Invalid MCP output policy.");
  const input = options.input ?? { messageBytes: 1048576, maxMessages: 64, windowMs: 1000 };
  if (input)
    for (const value of [input.messageBytes, input.maxMessages, input.windowMs])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new APIError("INVALID_ARGUMENT", "Invalid MCP input policy.");
  const work = options.work ?? { maxCalls: 2, maxWaiting: 8 };
  if (work)
    for (const value of [work.maxCalls, work.maxWaiting])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new APIError("INVALID_ARGUMENT", "Invalid MCP work policy.");
  let activeCalls = 0;
  const callTails = new Set<Promise<unknown>>();
  const waiting: {
    signal: AbortSignal;
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (cause: unknown) => void;
    abort: () => void;
  }[] = [];
  const pump = () => {
    while (waiting.length && activeCalls < (work?.maxCalls ?? Infinity)) {
      const entry = waiting.shift()!;
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) {
        entry.reject(new APIError("CANCELLED_OR_TIMEOUT", "MCP request cancelled."));
        continue;
      }
      activeCalls++;
      void entry
        .run()
        .then(entry.resolve, entry.reject)
        .finally(() => {
          activeCalls--;
          pump();
        });
    }
  };
  const invoke: NonNullable<McpIntegrationOptions["invoke"]> = (
    operation,
    context,
    args,
    client,
  ) => {
    const execute = async () => {
      if (closed || context.mcpReq.signal.aborted)
        throw new APIError("NOT_CONNECTED", "MCP owner is closed.");
      await client.connect({ signal: context.mcpReq.signal, joinPhysical: true });
      if (context.mcpReq.signal.aborted)
        throw new APIError("CANCELLED_OR_TIMEOUT", "MCP request cancelled.");
      if (closed || client.registration?.kind !== "agent")
        throw new APIError("FORBIDDEN", "MCP requires a registered agent client.");
      if (options.invoke) return options.invoke(operation, context, args, client);
      return client.call(operation, args, { signal: context.mcpReq.signal, joinPhysical: true });
    };
    const run = () => {
      const tail = execute().finally(() => callTails.delete(tail));
      callTails.add(tail);
      return tail;
    };
    if (!work) return run();
    if (waiting.length >= work.maxWaiting)
      return Promise.reject(new APIError("LIMIT", "MCP work queue limit reached."));
    return new Promise((resolve, reject) => {
      const signal = context.mcpReq.signal;
      const entry = {
        signal,
        run,
        resolve,
        reject,
        abort: () => {
          const position = waiting.indexOf(entry);
          if (position >= 0) {
            waiting.splice(position, 1);
            signal.removeEventListener("abort", entry.abort);
            reject(new APIError("CANCELLED_OR_TIMEOUT", "MCP request cancelled."));
          }
        },
      };
      waiting.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      pump();
    });
  };
  let windowStart = performance.now();
  let receivedMessages = 0;
  let outputBytes = 0;
  let outputMessages = 0;
  let writeTail: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  let pumping: Promise<void> | undefined;
  // The exact SDK audit is documented in docs/mcp-lifecycle.md. A checkpoint
  // drains finite SDK promise continuations AFTER actual owned tails. It is
  // never a timeout, a response-only refund or a cancellation acknowledgement.
  const reconsider = (record: Inbound) => {
    if (!records.has(record) || record.checkpoint) return;
    record.checkpoint = setImmediate(() => {
      record.checkpoint = undefined;
      if (!record.entered || record.handlers || record.writes || record.subscription) return;
      records.delete(record);
      if ("id" in record.message && "method" in record.message) requests.delete(record.message.id);
    });
  };
  const trackRequest: NonNullable<McpIntegrationOptions["trackRequest"]> = (context, run) => {
    const record = requests.get(context.mcpReq.id);
    if (!record) {
      deny();
      return Promise.reject(new APIError("NOT_CONNECTED", "MCP request has no admission owner."));
    }
    record.handlers++;
    const done = Promise.resolve()
      .then(run)
      .finally(() => {
        record.handlers--;
        handlerTails.delete(done);
        reconsider(record);
      });
    handlerTails.add(done);
    record.handlerTail = done;
    return done;
  };
  const report = () => {
    try {
      void Promise.resolve(options.onerror?.()).catch(() => {});
    } catch {
      /* Reporting cannot interrupt owned cleanup. */
    }
  };
  const deny = () => {
    closed = true;
    report();
    void close().catch(report);
  };
  const cleanup = (client: ManagementClient): Promise<void> => {
    const previous = clients.get(client);
    if (previous) return previous;
    const done = Promise.resolve()
      .then(() => (options.closeClient ? options.closeClient(client) : client.close()))
      .then(
        () => {
          clients.delete(client);
        },
        () => {
          report();
          throw new APIError("API_UNAVAILABLE", "MCP client cleanup remains unresolved.");
        },
      );
    clients.set(client, done);
    return done;
  };
  const transport: Transport = {
    start: () => wire.start(),
    send: (message, sendOptions) => {
      let bytes: number;
      try {
        bytes = clientJsonBytes(message, output.messageBytes - 1) + 1;
      } catch {
        deny();
        return Promise.reject(new APIError("LIMIT", "MCP output limit reached."));
      }
      if (outputMessages >= output.maxMessages || outputBytes + bytes > output.queuedBytes) {
        deny();
        return Promise.reject(new APIError("LIMIT", "MCP output queue limit reached."));
      }
      const subscriptionId =
        "method" in message
          ? message.params?._meta?.["io.modelcontextprotocol/subscriptionId"]
          : undefined;
      const record =
        "id" in message && message.id !== undefined
          ? requests.get(message.id)
          : typeof subscriptionId === "string" || typeof subscriptionId === "number"
            ? requests.get(subscriptionId)
            : undefined;
      if (record) {
        record.writes++;
        if ("method" in message && message.method === "notifications/subscriptions/acknowledged")
          record.subscription = true;
        else if ("id" in message) record.subscription = false;
      }
      outputBytes += bytes;
      outputMessages++;
      const done = writeTail
        .then(() => wire.send(message, sendOptions))
        .finally(() => {
          outputBytes -= bytes;
          outputMessages--;
          if (record) {
            record.writes--;
            reconsider(record);
          }
        });
      writeTail = done.catch(() => {
        deny();
      });
      return done;
    },
    close: () => wire.close(),
  };
  // SDK serveStdio's private pump never has a backlog: one entry at a time,
  // with factory and actual output barriers. Tool handlers can keep running.
  const pumpInput = async () => {
    while (queue.length && !closed) {
      const record = queue.shift()!;
      transport.onmessage?.(record.message, record.extra);
      do {
        await Promise.allSettled([
          ...factories,
          writeTail,
          ...("method" in record.message &&
          record.message.method === "server/discover" &&
          record.handlerTail
            ? [record.handlerTail]
            : []),
        ]);
        await nextTurn();
      } while (
        factories.size ||
        outputMessages ||
        ("method" in record.message &&
          record.message.method === "server/discover" &&
          record.handlers)
      );
      record.entered = true;
      if ("method" in record.message && record.message.method === "notifications/cancelled") {
        const id = record.message.params?.requestId;
        const subscription =
          typeof id === "string" || typeof id === "number" ? requests.get(id) : undefined;
        // The audited entry has now actually applied router.cancel, including
        // any preceding ACK/write. A received cancellation alone proves nothing.
        if (subscription?.subscription) {
          subscription.subscription = false;
          reconsider(subscription);
        }
      }
      reconsider(record);
    }
  };
  wire.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    if (closed) return;
    const now = performance.now();
    if (now - windowStart >= input.windowMs) {
      windowStart = now;
      receivedMessages = 0;
    }
    try {
      clientJsonBytes(message, input.messageBytes);
    } catch {
      deny();
      return;
    }
    const request = "id" in message && "method" in message;
    if (
      ++receivedMessages > input.maxMessages ||
      records.size >= admission.maxMessages ||
      (request && (requests.size >= admission.maxRequests || requests.has(message.id)))
    ) {
      deny();
      return;
    }
    const record: Inbound = {
      message,
      extra,
      entered: false,
      handlers: 0,
      writes: 0,
      subscription: false,
    };
    records.add(record);
    if (request) requests.set(message.id, record);
    queue.push(record);
    if (!pumping) {
      pumping = pumpInput()
        .catch(deny)
        .finally(() => {
          pumping = undefined;
        });
    }
  };
  wire.onerror = (error) => {
    if (closed) return;
    // The official decoder rejects malformed frames before onmessage/budget admission.
    closed = true;
    try {
      transport.onerror?.(error);
    } finally {
      void close().catch(report);
    }
  };
  wire.onclose = () => {
    closed = true;
    transport.onclose?.();
    void close().catch(report);
  };
  let resolveHandle!: (value: ReturnType<typeof sdk.serveStdio>) => void;
  const handleReady = new Promise<ReturnType<typeof sdk.serveStdio>>((resolve) => {
    resolveHandle = resolve;
  });
  const handle = sdk.serveStdio(
    () => {
      if (closed || clients.size + factories.size >= 2)
        throw new APIError("LIMIT", "MCP client ownership limit reached.");
      const factory = Promise.resolve()
        .then(() => options.createClient())
        .then(async (client) => {
          clients.set(client, undefined);
          if (closed) {
            await cleanup(client);
            throw new APIError("NOT_CONNECTED", "MCP owner is closed.");
          }
          const server = createMcpServer(client, {
            trackRequest,
            beforeCall: async (operation, context, args) => {
              if (closed) throw new APIError("NOT_CONNECTED", "MCP owner is closed.");
              await options.beforeCall?.(operation, context, args);
            },
            invoke,
            onCleanupError: report,
          });
          server.server.onclose = () => {
            void cleanup(client).catch(report);
          };
          return server;
        })
        .finally(() => factories.delete(factory));
      factories.add(factory);
      return factory;
    },
    {
      legacy: options.legacy ?? "serve",
      transport,
      maxSubscriptions,
      onerror: report,
    },
  );
  resolveHandle(handle);
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    for (const entry of waiting.splice(0)) {
      entry.signal.removeEventListener("abort", entry.abort);
      entry.reject(new APIError("NOT_CONNECTED", "MCP owner is closed."));
    }
    closing = (async () => {
      await (await handleReady).close();
      await pumping;
      await Promise.allSettled([...handlerTails, ...callTails, ...factories]);
      await writeTail;
      const cleanups = await Promise.allSettled([...clients.keys()].map(cleanup));
      for (const result of cleanups) if (result.status === "rejected") throw result.reason;
      await nextTurn();
      queue.length = 0;
      for (const record of records) if (record.checkpoint) clearImmediate(record.checkpoint);
      records.clear();
      requests.clear();
    })();
    return closing;
  }
  return {
    close,
    usage: () =>
      Object.freeze({
        requests: requests.size,
        messages: records.size,
        handlers: handlerTails.size,
        queuedMessages: queue.length,
        clients: clients.size,
        factories: factories.size,
        calls: activeCalls,
        waitingCalls: waiting.length,
        outputMessages,
        outputBytes,
      }),
  };
}
