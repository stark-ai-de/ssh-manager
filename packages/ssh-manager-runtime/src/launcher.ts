import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APIError, ManagementClient, assertLoopback } from "./client.js";

export function defaultStateDirectory() {
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "stark-ai",
      "ssh-manager",
    );
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "stark-ai", "ssh-manager");
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "stark-ai",
    "ssh-manager",
  );
}
async function locate(directory: string) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"), "utf8"));
    const url = assertLoopback(metadata.url);
    const client = await new ManagementClient(
      url,
      fs.readFileSync(path.join(directory, "agent.token"), "utf8").trim(),
    ).connect(AbortSignal.timeout(1000));
    await client.close();
    return url;
  } catch {
    return undefined;
  }
}
export async function ensureRuntime(
  options: { stateDirectory?: string; daemonFile?: string; signal?: AbortSignal } = {},
) {
  const directory = options.stateDirectory ?? defaultStateDirectory();
  const existing = await locate(directory);
  if (existing) return { url: existing, stateDirectory: directory };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const startup = path.join(directory, "startup.lock");
  let owner = false;
  try {
    fs.writeFileSync(startup, JSON.stringify({ pid: process.pid, time: Date.now() }), {
      flag: "wx",
      mode: 0o600,
    });
    owner = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const lock = JSON.parse(fs.readFileSync(startup, "utf8"));
      if (Date.now() - lock.time > 30000) {
        try {
          process.kill(lock.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") fs.unlinkSync(startup);
        }
      }
    } catch {
      /* A competing starter owns recovery. */
    }
  }
  if (owner) {
    const bundled = fileURLToPath(new URL("./daemon.mjs", import.meta.url));
    const daemonFile =
      options.daemonFile ??
      (fs.existsSync(bundled) ? bundled : fileURLToPath(new URL("./daemon.js", import.meta.url)));
    const child = spawn(process.execPath, [daemonFile, "--state-directory", directory], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    child.on("error", () => {
      try {
        fs.unlinkSync(startup);
      } catch {
        /* Another starter may have completed. */
      }
    });
  }
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const url = await locate(directory);
      if (url) return { url, stateDirectory: directory };
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new APIError(
      "RUNTIME_START_FAILED",
      "Local daemon did not become ready. Check Node 24 compatibility and the local state ownership marker.",
    );
  } finally {
    if (owner) {
      try {
        fs.unlinkSync(startup);
      } catch {
        /* Marker already removed by this starter. */
      }
    }
  }
}
export async function localClient(
  kind: "agent" | "operator",
  options: { stateDirectory?: string; daemonFile?: string; signal?: AbortSignal } = {},
) {
  const runtime = await ensureRuntime(options);
  return new ManagementClient(
    runtime.url,
    fs.readFileSync(path.join(runtime.stateDirectory, `${kind}.token`), "utf8").trim(),
  ).connect(options.signal);
}
