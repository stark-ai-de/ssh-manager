import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import {
  catalog,
  resultSchema,
  type Operation,
  type OperationInputs,
} from "@stark-ai/ssh-manager-runtime/catalog";
import { APIError, type ManagementClient } from "@stark-ai/ssh-manager-runtime/client";

export interface McpIntegrationOptions {
  /** Trusted embedding may apply scoped policy while retaining canonical tool/schema/transport ownership. */
  invoke?: (
    operation: Operation,
    context: ServerContext,
    args: OperationInputs[Operation],
    client: ManagementClient,
  ) => Promise<unknown>;
  beforeCall?: (
    operation: Operation,
    context: ServerContext,
    args: OperationInputs[Operation],
  ) => Promise<void>;
  onCleanupError?: () => void;
  /** @internal Canonical stdio owns the entire SDK tool-handler tail, including validation. */
  trackRequest?: <T>(context: ServerContext, run: () => T | Promise<T>) => Promise<T>;
}
export function createMcpServer(client: ManagementClient, options: McpIntegrationOptions = {}) {
  // registerTool declares the tools capability itself. Declaring it in the
  // constructor would eagerly install handlers before the lifecycle observer.
  const server = new McpServer({ name: "stark-ssh-management", version: "1.0.0" });
  if (options.trackRequest) {
    const register = server.server.setRequestHandler.bind(server.server);
    type Handler = (params: unknown, context: ServerContext) => unknown;
    // Decorate only the public registration API. The SDK still owns dispatch,
    // schemas, tool registration and both wire revisions; no private fields.
    server.server.setRequestHandler = ((method: string, ...args: unknown[]) => {
      const handler = args.pop() as Handler;
      const observed: Handler = (params, context) =>
        options.trackRequest!(context, () => handler(params, context));
      Reflect.apply(register, undefined, [method, ...args, observed]);
    }) as typeof register;
  }
  for (const [name, definition] of Object.entries(catalog)) {
    if (definition.operator) continue;
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.schema,
        outputSchema: resultSchema(name as Operation),
        annotations: definition.annotations,
      },
      async (args: any, context: ServerContext) => {
        try {
          await options.beforeCall?.(name as Operation, context, args);
          const signal = context.mcpReq.signal;
          if (signal.aborted) throw new APIError("CANCELLED_OR_TIMEOUT", "MCP request cancelled.");
          await client.connect({ signal, joinPhysical: true });
          if (signal.aborted) throw new APIError("CANCELLED_OR_TIMEOUT", "MCP request cancelled.");
          if (client.registration?.kind !== "agent")
            throw new APIError("FORBIDDEN", "MCP requires a registered agent client.");
          const structuredContent = {
            data: options.invoke
              ? await options.invoke(name as Operation, context, args, client)
              : await client.call(name as Operation, args, {
                  signal: context.mcpReq.signal,
                  joinPhysical: true,
                }),
          };
          return {
            structuredContent,
            content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          };
        } catch (error) {
          const e =
            error instanceof APIError
              ? error
              : new APIError("OPERATION_FAILED", "Local SSH management operation failed.");
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: {
                    code: e.code,
                    message: e.message,
                    ...(e.details ? { details: e.details } : {}),
                  },
                }),
              },
            ],
          };
        }
      },
    );
  }
  server.server.onclose = () => {
    void client.close().catch(() => options.onCleanupError?.());
  };
  return server;
}
