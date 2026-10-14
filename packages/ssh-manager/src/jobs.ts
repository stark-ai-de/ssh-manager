import type { ClientChannel } from "ssh2";
import {
  fault,
  type Actor,
  type Profile,
  type JobInfo,
  type Capability,
  type ManagerEvent,
} from "./contracts.js";
import { ConnectionPool, type Lease } from "./connections.js";
import type { JobOptions, GroupResult } from "./public-api.js";
import { id, now, request, OutputBuffer, aborted, authorizedResourceInfo } from "./util.js";

export function shellCommand(profile: Profile, command: string) {
  if (profile.shell === "powershell")
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  if (profile.shell === "cmd") return `cmd.exe /d /s /c "${command.replace(/"/g, '""')}"`;
  return command;
}
type Job = {
  info: JobInfo;
  output: OutputBuffer;
  channel: ClientChannel;
  lease: Lease;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
};
export class Jobs {
  private jobs = new Map<string, Job>();
  private opening = 0;
  constructor(
    private pool: ConnectionPool,
    private authorize: (actor: Actor, id: string, cap: Capability) => Profile,
    private emit: (event: ManagerEvent) => void,
    private maximum: number,
    private outputBytes: number,
  ) {
    pool.on("lost", (connectionId: string) => {
      for (const job of this.jobs.values())
        if (job.lease.info.id === connectionId && job.info.state === "running")
          this.finish(job, "unknown");
    });
  }
  async start(actor: Actor, targetId: string, command: string, options: JobOptions = {}) {
    const profile = this.authorize(actor, targetId, "shell");
    if (
      typeof command !== "string" ||
      !command.length ||
      Buffer.byteLength(command) > 65536 ||
      command.includes("\0")
    )
      fault("INVALID_ARGUMENT", "Command is empty or exceeds its limit.");
    const timeout = options.timeout ?? 300000;
    if (!Number.isFinite(timeout) || timeout < 100 || timeout > 86400000)
      fault("INVALID_ARGUMENT", "Job timeout is outside its supported range.");
    if (
      [...this.jobs.values()].filter((j) => j.info.state === "running").length + this.opening >=
      this.maximum
    )
      fault("LIMIT", "Running job limit reached.");
    this.opening++;
    let lease: Lease | undefined;
    try {
      lease = await this.pool.acquire(actor, targetId, "shell", options.signal);
      const info: JobInfo = { id: id(), targetId, state: "running", createdAt: now() };
      let job!: Job;
      await request<ClientChannel>(
        (cb) => lease!.client.exec(shellCommand(profile, command), cb),
        this.pool.limits.channelTimeout,
        options.signal,
        (c) => c.close(),
        (channel) => {
          job = {
            info,
            channel,
            lease: lease!,
            output: new OutputBuffer(this.outputBytes),
            timer: setTimeout(() => this.cancelInternal(job), timeout),
          };
          const cancel = () => this.cancelInternal(job);
          job.abort = cancel;
          options.signal?.addEventListener("abort", cancel, { once: true });
          channel.on("data", (data: Buffer) => job.output.append(data));
          channel.stderr.on("data", (data: Buffer) => job.output.append(data, "stderr"));
          channel.on("exit", (code: number | null, signal?: string) => {
            if (code !== null) job.info.exitCode = code;
            if (signal) job.info.signal = signal;
          });
          channel.on("error", () => this.finish(job, "unknown"));
          channel.on("close", () => {
            options.signal?.removeEventListener("abort", cancel);
            if (job.info.state === "running")
              this.finish(
                job,
                job.info.exitCode === undefined
                  ? "unknown"
                  : job.info.exitCode === 0
                    ? "succeeded"
                    : "failed",
              );
          });
          this.jobs.set(info.id, job);
        },
      );
      this.trim();
      this.emit({ type: "job.state", id: info.id, targetId });
      aborted(options.signal);
      return { ...info };
    } catch (error) {
      lease?.release();
      throw error;
    } finally {
      this.opening--;
    }
  }
  private trim() {
    if (this.jobs.size <= 256) return;
    for (const [id, job] of this.jobs) {
      if (job.info.state !== "running") this.jobs.delete(id);
      if (this.jobs.size <= 256) break;
    }
  }
  private finish(job: Job, state: JobInfo["state"]) {
    if (job.info.state !== "running") return;
    job.info.state = state;
    clearTimeout(job.timer);
    job.lease.release();
    this.emit({ type: "job.state", id: job.info.id, targetId: job.info.targetId });
  }
  private cancelInternal(job: Job) {
    if (job.info.state !== "running") return;
    // Channel close and best-effort signal do not prove that detached remote descendants stopped.
    try {
      job.channel.signal("TERM");
    } catch {
      /* Some SSH servers do not implement signal requests. */
    }
    job.channel.close();
    this.finish(job, "cancelled");
  }
  private get(actor: Actor, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) fault("NOT_FOUND", "Job is no longer retained.");
    this.authorize(actor, job.info.targetId, "shell");
    return job;
  }
  read(actor: Actor, jobId: string, cursor = 0) {
    const job = this.get(actor, jobId);
    return {
      job: { ...job.info },
      output: job.output.page(cursor),
      remoteTerminationConfirmed: job.info.state === "succeeded" || job.info.state === "failed",
    };
  }
  list(actor: Actor, targetId?: string) {
    return authorizedResourceInfo(this.jobs.values(), (info) => this.get(actor, info.id), targetId);
  }
  cancel(actor: Actor, jobId: string) {
    const job = this.get(actor, jobId);
    this.cancelInternal(job);
    return { ...job.info, remoteTerminationConfirmed: false };
  }
  async group(actor: Actor, targets: string[], command: string, options: JobOptions = {}) {
    if (targets.length > 64 || !targets.length || new Set(targets).size !== targets.length)
      fault("INVALID_ARGUMENT", "Group requires one to 64 distinct explicit targets.");
    const results: GroupResult[] = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (index < targets.length) {
          const targetId = targets[index++]!;
          try {
            results.push({ targetId, job: await this.start(actor, targetId, command, options) });
          } catch (error) {
            const e = error as { code?: string };
            results.push({
              targetId,
              error: { code: e.code ?? "INTERNAL", message: "Target job could not be started." },
            });
          }
        }
      }),
    );
    return targets.map((id) => results.find((r) => r.targetId === id)!);
  }
  shutdown() {
    for (const job of this.jobs.values())
      if (job.info.state === "running") {
        job.channel.close();
        this.finish(job, "unknown");
      }
  }
}
