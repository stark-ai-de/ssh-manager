import { SSHManager } from "@stark-ai/ssh-manager";

/** Independent consumer: the embedder owns authentication, setup and shutdown. */
export async function runApprovedCommand({
  stateDirectory,
  targetId,
  command,
  actor,
  signal,
  setup,
}) {
  const manager = new SSHManager({ stateDirectory });
  try {
    if (setup) await setup(manager);
    const job = await manager.jobs.start(actor, targetId, command, { signal });
    while (true) {
      const result = manager.jobs.read(actor, job.id);
      if (result.job.state !== "running") return result;
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    manager.shutdown();
  }
}
