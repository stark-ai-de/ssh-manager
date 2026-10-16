#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { serveManagementStdio } from "./stdio.js";
import { ensureRuntime } from "@stark-ai/ssh-manager-runtime/launcher";
import { ManagementClient } from "@stark-ai/ssh-manager-runtime/client";
import path from "node:path";

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
  const handle = serveManagementStdio({
    createClient: () =>
      new ManagementClient(
        runtime.url,
        fs.readFileSync(path.join(runtime.stateDirectory, "agent.token"), "utf8").trim(),
        { expectedKind: "agent" },
      ),
    onerror: () => console.error("MCP transport error; inspect protocol compatibility."),
  });
  const close = () => {
    void handle.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
}
export { serveManagementStdio, supportsReusableManagementStdio } from "./stdio.js";
export const supportsScopedManagementStdio = true;
if (import.meta.main)
  void main().catch(() => {
    console.error(
      "SSH management MCP startup failed. Start the local daemon with Node 24 and complete trusted local setup.",
    );
    process.exitCode = 1;
  });
