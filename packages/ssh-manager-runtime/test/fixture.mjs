import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/server.js";
import { ManagementClient } from "../dist/client.js";

/** Own one local runtime and its authenticated clients for the test lifetime. */
export async function runtimeFixture(t, { temporaryRoot = os.tmpdir(), clientTtlMs } = {}) {
  let directory, runtime, human, agent, closing;
  const close = () =>
    (closing ??= Promise.resolve().then(async () => {
      const errors = [];
      for (const step of [
        () => human?.close(),
        () => agent?.close(),
        () => runtime?.close(),
        () => directory && fs.rmSync(directory, { recursive: true, force: true }),
      ]) {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Runtime fixture cleanup failed.");
    }));
  try {
    t.after(close);
    directory = fs.mkdtempSync(path.join(temporaryRoot, "ssh-runtime-test-"));
    runtime = await createRuntime({
      stateDirectory: directory,
      knownHosts: [],
      clientTtlMs,
      limits: { authTimeout: 1500, channelTimeout: 1500 },
    });
    // Own each client before connect: failed registration can still require cleanup.
    human = new ManagementClient(runtime.url, runtime.operatorToken, { strictCleanup: true });
    await human.connect();
    agent = new ManagementClient(runtime.url, runtime.agentToken, { strictCleanup: true });
    await agent.connect();
    return { directory, runtime, human, agent, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Runtime fixture setup and rollback failed.");
    }
    throw error;
  }
}
