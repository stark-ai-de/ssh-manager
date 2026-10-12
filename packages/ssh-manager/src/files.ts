import path from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SFTPWrapper, Stats, FileEntryWithStats } from "ssh2";
import { fault, ManagementError, type Actor, type Capability, type Profile } from "./contracts.js";
import { ConnectionPool, type Lease } from "./connections.js";
import { aborted, request } from "./util.js";

export class Files {
  private active = 0;
  constructor(
    private pool: ConnectionPool,
    private authorize: (actor: Actor, id: string, cap: Capability) => Profile,
    private maximum: number,
    private fileBytes: number,
  ) {}
  private async open(actor: Actor, targetId: string, write: boolean, signal?: AbortSignal) {
    const profile = this.authorize(actor, targetId, write ? "files.write" : "files.read");
    if (this.active >= this.maximum) fault("LIMIT", "File transfer limit reached.");
    this.active++;
    let lease: Lease | undefined;
    try {
      lease = await this.pool.acquire(
        actor,
        targetId,
        write ? "files.write" : "files.read",
        signal,
      );
      const sftp = await request<SFTPWrapper>(
        (cb) => lease!.client.sftp(cb),
        this.pool.limits.channelTimeout,
        signal,
        (s) => s.end(),
      );
      let released = false;
      return {
        sftp,
        profile,
        close: () => {
          if (released) return;
          released = true;
          sftp.end();
          lease!.release();
          this.active--;
        },
      };
    } catch (error) {
      lease?.release();
      this.active--;
      throw error;
    }
  }
  private async checked(
    sftp: SFTPWrapper,
    profile: Profile,
    remote: string,
    create: boolean,
    signal?: AbortSignal,
  ) {
    if (
      typeof remote !== "string" ||
      !remote.startsWith("/") ||
      remote.length > 2048 ||
      /[\\\x00-\x1f]/.test(remote) ||
      remote.split("/").includes("..")
    )
      fault("PATH_DENIED", "Use an absolute SFTP path without traversal or control characters.");
    const canonical = path.posix.normalize(remote);
    const within = (actual: string) =>
      profile.fileRoots.some(
        (root) =>
          actual === path.posix.normalize(root) ||
          actual.startsWith(path.posix.normalize(root).replace(/\/$/, "") + "/"),
      );
    if (!within(canonical))
      fault("PATH_DENIED", "Path is outside the target's permitted file roots.");
    let actual: string;
    try {
      actual = await request<string>(
        (cb) => sftp.realpath(canonical, cb),
        this.pool.limits.channelTimeout,
        signal,
      );
    } catch (error) {
      if (
        !create ||
        (error instanceof ManagementError && ["CANCELLED", "TIMEOUT"].includes(error.code))
      )
        throw error;
      const parent = await request<string>(
        (cb) => sftp.realpath(path.posix.dirname(canonical), cb),
        this.pool.limits.channelTimeout,
        signal,
      );
      actual = path.posix.join(parent, path.posix.basename(canonical));
    }
    if (!within(actual)) fault("PATH_DENIED", "A remote symlink leaves the permitted file roots.");
    return canonical;
  }
  private metadata(stats: Stats) {
    return {
      size: stats.size,
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      atime: stats.atime,
      mtime: stats.mtime,
      directory: stats.isDirectory(),
      file: stats.isFile(),
      symlink: stats.isSymbolicLink(),
    };
  }
  async list(actor: Actor, targetId: string, remote: string, signal?: AbortSignal) {
    const ctx = await this.open(actor, targetId, false, signal);
    try {
      const actual = await this.checked(ctx.sftp, ctx.profile, remote, false, signal);
      const handle = await request<Buffer>(
        (cb) => ctx.sftp.opendir(actual, cb),
        this.pool.limits.channelTimeout,
        signal,
      );
      const result: FileEntryWithStats[] = [];
      let nameBytes = 0;
      try {
        while (true) {
          const chunk = await request<FileEntryWithStats[]>(
            (cb) =>
              ctx.sftp.readdir(handle, (error: any, entries: any) => {
                if (error?.code === 1) cb(null, []);
                else cb(error, entries === false ? [] : entries);
              }),
            this.pool.limits.channelTimeout,
            signal,
          );
          if (!chunk.length) break;
          nameBytes += chunk.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.filename), 0);
          if (result.length + chunk.length > 4096 || nameBytes > 512 * 1024)
            fault("LIMIT", "Directory result exceeds its entry or name-byte limit.");
          result.push(...chunk);
        }
      } finally {
        await request<void>(
          (cb) => ctx.sftp.close(handle, cb),
          Math.min(this.pool.limits.channelTimeout, 250),
          signal,
        ).catch(() => {});
      }
      return result.map((entry) => ({ name: entry.filename, ...this.metadata(entry.attrs) }));
    } finally {
      ctx.close();
    }
  }
  async stat(actor: Actor, targetId: string, remote: string, signal?: AbortSignal) {
    const ctx = await this.open(actor, targetId, false, signal);
    try {
      const actual = await this.checked(ctx.sftp, ctx.profile, remote, false, signal);
      return this.metadata(
        await request<Stats>(
          (cb) => ctx.sftp.stat(actual, cb),
          this.pool.limits.channelTimeout,
          signal,
        ),
      );
    } finally {
      ctx.close();
    }
  }
  async mutate(
    actor: Actor,
    targetId: string,
    operation: "mkdir" | "rename" | "remove" | "chmod",
    remote: string,
    options: {
      destination?: string;
      mode?: number;
      directory?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const ctx = await this.open(actor, targetId, true, options.signal);
    try {
      const actual = await this.checked(
        ctx.sftp,
        ctx.profile,
        remote,
        operation === "mkdir",
        options.signal,
      );
      const mode = options.mode ?? 0o700;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
        fault("INVALID_ARGUMENT", "Only regular permission bits are supported.");
      let destination: string | undefined;
      if (operation === "rename")
        destination = await this.checked(
          ctx.sftp,
          ctx.profile,
          options.destination ?? "",
          true,
          options.signal,
        );
      await request<void>(
        (cb) => {
          if (operation === "mkdir") ctx.sftp.mkdir(actual, { mode }, cb);
          else if (operation === "rename") ctx.sftp.rename(actual, destination!, cb);
          else if (operation === "remove")
            options.directory ? ctx.sftp.rmdir(actual, cb) : ctx.sftp.unlink(actual, cb);
          else ctx.sftp.chmod(actual, mode, cb);
        },
        this.pool.limits.channelTimeout,
        options.signal,
      );
      return { completed: true };
    } finally {
      ctx.close();
    }
  }
  async download(
    actor: Actor,
    targetId: string,
    remote: string,
    options: {
      signal?: AbortSignal;
      offset?: number;
      length?: number;
      progress?: (bytes: number) => void;
    } = {},
  ): Promise<Readable> {
    const ctx = await this.open(actor, targetId, false, options.signal);
    try {
      const actual = await this.checked(ctx.sftp, ctx.profile, remote, false, options.signal);
      const stats = await request<Stats>(
        (cb) => ctx.sftp.stat(actual, cb),
        this.pool.limits.channelTimeout,
        options.signal,
      );
      if (!stats.isFile()) fault("INVALID_ARGUMENT", "Download requires a regular file.");
      const offset = options.offset ?? 0,
        length = options.length ?? Math.max(stats.size - offset, 0);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > this.fileBytes
      )
        fault("LIMIT", "Download range exceeds its size limit.");
      const output = new PassThrough({ highWaterMark: 65536 });
      output.on("error", () => {});
      if (length === 0) {
        output.end();
        ctx.close();
        return output;
      }
      const source = ctx.sftp.createReadStream(actual, {
        start: offset,
        end: offset + length - 1,
        highWaterMark: 65536,
      });
      const limiter = this.limiter(options.progress, length);
      const timer = setTimeout(
        () => source.destroy(new ManagementError("TIMEOUT", "SFTP transfer timed out.")),
        this.pool.limits.channelTimeout,
      );
      limiter.on("data", () => timer.refresh());
      void pipeline(source, limiter, output, { signal: options.signal })
        .catch(() =>
          output.destroy(
            new ManagementError(
              options.signal?.aborted ? "CANCELLED" : "TRANSFER_FAILED",
              "Download was interrupted.",
            ),
          ),
        )
        .finally(() => {
          clearTimeout(timer);
          ctx.close();
        });
      output.once("close", () => source.destroy());
      return output;
    } catch (error) {
      ctx.close();
      throw error;
    }
  }
  async upload(
    actor: Actor,
    targetId: string,
    remote: string,
    input: Readable,
    options: { signal?: AbortSignal; progress?: (bytes: number) => void; mode?: number } = {},
  ) {
    const ctx = await this.open(actor, targetId, true, options.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const actual = await this.checked(ctx.sftp, ctx.profile, remote, true, options.signal);
      aborted(options.signal);
      const mode = options.mode ?? 0o600;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
        fault("INVALID_ARGUMENT", "Invalid upload permissions.");
      const destination = ctx.sftp.createWriteStream(actual, {
        flags: "w",
        mode,
        highWaterMark: 65536,
      });
      const limiter = this.limiter(options.progress, this.fileBytes);
      timer = setTimeout(() => {
        destination.emit("error", new ManagementError("TIMEOUT", "SFTP transfer timed out."));
        destination.destroy();
      }, this.pool.limits.channelTimeout);
      limiter.on("data", () => timer?.refresh());
      await pipeline(input, limiter, destination, { signal: options.signal });
      return { completed: true };
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      fault(
        options.signal?.aborted ? "CANCELLED" : "TRANSFER_FAILED",
        "Upload was interrupted; a partial remote file may remain.",
      );
    } finally {
      if (timer) clearTimeout(timer);
      ctx.close();
    }
  }
  private limiter(progress: ((bytes: number) => void) | undefined, maximum: number) {
    let bytes = 0;
    return new Transform({
      highWaterMark: 65536,
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maximum)
          callback(new ManagementError("LIMIT", "Transfer exceeded its byte limit."));
        else {
          progress?.(bytes);
          callback(null, chunk);
        }
      },
    });
  }
  async read(
    actor: Actor,
    targetId: string,
    remote: string,
    offset = 0,
    length = 65536,
    signal?: AbortSignal,
  ) {
    if (length > 65536) fault("LIMIT", "Use streaming download or bounded 64 KiB chunks.");
    const stream = await this.download(actor, targetId, remote, { offset, length, signal });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return {
      data: Buffer.concat(chunks).toString("base64"),
      encoding: "base64" as const,
      offset,
      bytes: chunks.reduce((n, b) => n + b.length, 0),
    };
  }
}
