#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ensureRuntime } from "@stark-ai/ssh-manager-runtime/launcher";
import { ManagementClient } from "@stark-ai/ssh-manager-runtime/client";
import path from "node:path";
import { createMcpServer } from "./server.js";

async function main() {
  const directoryIndex = process.argv.indexOf("--state-directory");
  const daemonIndex = process.argv.indexOf("--daemon-file");
  const bundled = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
  const fs = await import("node:fs");
  const runtime = await ensureRuntime({
    stateDirectory: directoryIndex < 0 ? undefined : process.argv[directoryIndex + 1],
    daemonFile:
      daemonIndex < 0
        ? fs.existsSync(bundled)
          ? bundled
          : undefined
        : process.argv[daemonIndex + 1],
  });
  const clients = new Set<ManagementClient>();
  const handle = serveStdio(
    async () => {
      const client = await new ManagementClient(
        runtime.url,
        fs.readFileSync(path.join(runtime.stateDirectory, "agent.token"), "utf8").trim(),
      ).connect();
      clients.add(client);
      const server = createMcpServer(client);
      server.server.onclose = () => {
        clients.delete(client);
        void client.close();
      };
      return server;
    },
    {
      legacy: "serve",
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 1024 * 1024,
      }),
      onerror: () => console.error("MCP transport error; inspect protocol compatibility."),
    },
  );
  const detach = () => Promise.all([...clients].map((c) => c.close()));
  const close = () => {
    void handle.close().finally(detach);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", () => {
    void detach();
  });
}
void main().catch(() => {
  console.error(
    "SSH management MCP startup failed. Start the local daemon with Node 24 and complete trusted local setup.",
  );
  process.exitCode = 1;
});
