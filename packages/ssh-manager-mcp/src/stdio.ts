import * as sdk from "@modelcontextprotocol/server/stdio";
import type { Transport, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/server";
import { APIError, ManagementClient, clientJsonBytes } from "@stark-ai/ssh-manager-runtime/client";
import type { McpIntegrationOptions } from "./server.js";
import { createMcpServer } from "./server.js";

export interface ManagementStdioOptions {
  /** Trusted embedding owns endpoint discovery and bootstrap provenance. No launcher fallback. */
  createClient: () => ManagementClient | Promise<ManagementClient>;
  transport?: Transport;
  legacy?: "serve" | "reject";
  maxSubscriptions?: number;
  /** Reusable concurrent admission requires the upstream SDK completion seam. */
  admission?: { maxRequests: number; maxMessages: number };
  onerror?: () => void;
  beforeCall?: McpIntegrationOptions["beforeCall"];
  input?: { messageBytes: number; maxMessages: number; windowMs: number };
  output?: { messageBytes: number; queuedBytes: number; maxMessages: number };
}
export interface ManagementStdioHandle {
  close(): Promise<void>;
}

export function serveManagementStdio(options: ManagementStdioOptions): ManagementStdioHandle {
  if (options.admission) {
    for (const value of [options.admission.maxRequests, options.admission.maxMessages])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new APIError("INVALID_ARGUMENT", "Invalid MCP admission policy.");
    if (
      !("supportsInboundMessageCompletion" in sdk) ||
      sdk.supportsInboundMessageCompletion !== true
    )
      throw new APIError(
        "UNSUPPORTED_SDK",
        "This MCP admission policy requires SDK processing completion support.",
      );
  }
  const wire =
    options.transport ??
    new sdk.StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1048576 });
  const clients = new Map<ManagementClient, Promise<void> | undefined>();
  const factories = new Set<Promise<unknown>>();
  const requests = new Set<string | number>();
  const output = options.output ?? {
    messageBytes: 67108864,
    queuedBytes: 100663296,
    maxMessages: 16,
  };
  for (const value of Object.values(output))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new APIError("INVALID_ARGUMENT", "Invalid MCP output policy.");
  const input = options.input;
  if (input)
    for (const value of Object.values(input))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new APIError("INVALID_ARGUMENT", "Invalid MCP input policy.");
  let windowStart = performance.now();
  let receivedMessages = 0;
  let outputBytes = 0;
  let outputMessages = 0;
  let writeTail: Promise<void> = Promise.resolve();
  let messages = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  const report = () => options.onerror?.();
  const deny = () => {
    closed = true;
    report();
    void close().catch(report);
  };
  const cleanup = (client: ManagementClient): Promise<void> => {
    const previous = clients.get(client);
    if (previous) return previous;
    const done = client.close().then(
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
      outputBytes += bytes;
      outputMessages++;
      const done = writeTail
        .then(() => wire.send(message, sendOptions))
        .finally(() => {
          outputBytes -= bytes;
          outputMessages--;
        });
      writeTail = done.catch(() => {});
      return done;
    },
    close: () => wire.close(),
  };
  wire.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    if (closed) return;
    if (input) {
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
      if (++receivedMessages > input.maxMessages) {
        deny();
        return;
      }
    }
    if (!options.admission) {
      transport.onmessage?.(message, extra);
      return;
    }
    const request = "id" in message && "method" in message;
    const id = request ? message.id : undefined;
    if (
      options.admission &&
      (messages >= options.admission.maxMessages ||
        (request && (requests.size >= options.admission.maxRequests || requests.has(id!))))
    ) {
      closed = true;
      report();
      void close().catch(report);
      return;
    }
    messages++;
    if (request) requests.add(id!);
    let processed = false;
    const onMessageProcessed = () => {
      if (processed) return;
      processed = true;
      messages--;
      if (request) requests.delete(id!);
      // New metadata remains structural on older declarations; bounded mode
      // refuses those SDK versions before transport.start, never faking refunds.
      if (extra && "onMessageProcessed" in extra && typeof extra.onMessageProcessed === "function")
        extra.onMessageProcessed();
    };
    const metadata = { ...extra, onMessageProcessed };
    transport.onmessage?.(message, metadata);
  };
  wire.onerror = (error) => {
    transport.onerror?.(error);
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
            beforeCall: async (operation, context) => {
              if (closed) throw new APIError("NOT_CONNECTED", "MCP owner is closed.");
              await options.beforeCall?.(operation, context);
              await client.connect(context.mcpReq.signal);
              if (closed || client.registration?.kind !== "agent")
                throw new APIError("FORBIDDEN", "MCP requires a registered agent client.");
            },
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
      maxSubscriptions: options.maxSubscriptions,
      onerror: report,
    },
  );
  resolveHandle(handle);
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await (await handleReady).close();
      await writeTail;
      await Promise.allSettled([...factories]);
      await Promise.all([...clients.keys()].map(cleanup));
    })();
    return closing;
  }
  return { close };
}
