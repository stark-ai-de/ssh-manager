import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import {
  catalog,
  resultSchema,
  type Operation,
  type OperationInputs,
} from "@stark-ai/ssh-manager-runtime/catalog";
import { APIError, type ManagementClient } from "@stark-ai/ssh-manager-runtime/client";

export interface McpIntegrationOptions {
  beforeCall?: (
    operation: Operation,
    context: ServerContext,
    args: OperationInputs[Operation],
  ) => Promise<void>;
  onCleanupError?: () => void;
}
export function createMcpServer(client: ManagementClient, options: McpIntegrationOptions = {}) {
  const server = new McpServer(
    { name: "stark-ssh-management", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
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
          const structuredContent = {
            data: await client.call(name as Operation, args, {
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
