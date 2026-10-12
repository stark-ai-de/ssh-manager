import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { ClientChannel } from "ssh2";
import {
  fault,
  ManagementError,
  type Actor,
  type Capability,
  type Profile,
  type SessionInfo,
  type ManagerEvent,
} from "./contracts.js";
import { ConnectionPool, type Lease } from "./connections.js";
import { StateStore } from "./state.js";
import { Vault } from "./vault.js";
import { id, now, OutputBuffer, request } from "./util.js";

type Terminal = InstanceType<typeof headless.Terminal>;
type Serialize = InstanceType<typeof serialize.SerializeAddon>;
type Session = {
  info: SessionInfo;
  lease?: Lease;
  channel?: ClientChannel;
  mirror: Terminal;
  serializer: Serialize;
  output: OutputBuffer;
  readers: Map<string, number>;
  writerUntil: number;
  pending: Promise<void>;
  recordingText: string;
  generation: number;
};
export class Sessions {
  private sessions = new Map<string, Session>();
  private opening = 0;
  private expiry: ReturnType<typeof setInterval>;
  constructor(
    private pool: ConnectionPool,
    private state: StateStore,
    private vault: Vault,
    private authorize: (actor: Actor, id: string, cap: Capability) => Profile,
    private emit: (event: ManagerEvent) => void,
    private maximum: number,
    private outputBytes: number,
  ) {
    for (const info of state.data.sessions) {
      const restored = {
        ...info,
        writer: undefined,
        state:
          info.state === "closed"
            ? ("closed" as const)
            : info.tmux
              ? ("recoverable" as const)
              : ("lost" as const),
        reason: "The previous daemon ended; remote terminal continuity has not been verified.",
      };
      this.sessions.set(info.id, this.make(restored));
      this.state.session(restored);
    }
    pool.on("lost", (connectionId: string) => {
      for (const session of this.sessions.values())
        if (session.lease?.info.id === connectionId && session.info.state === "running") {
          session.info.state = session.info.tmux ? "recoverable" : "lost";
          session.info.reason = "SSH connection was lost.";
          session.info.writer = undefined;
          session.writerUntil = 0;
          session.generation++;
          session.lease.release();
          this.changed(session);
        }
    });
    this.expiry = setInterval(() => {
      for (const session of this.sessions.values()) {
        for (const [actor, expiry] of session.readers)
          if (expiry < Date.now()) this.detachInternal(session, actor);
        if (session.writerUntil < Date.now() && session.info.writer) {
          session.info.writer = undefined;
          this.changed(session);
        }
      }
    }, 1000);
    this.expiry.unref();
  }
  private make(info: SessionInfo): Session {
    const mirror = new headless.Terminal({
      cols: info.cols,
      rows: info.rows,
      scrollback: 1000,
      allowProposedApi: true,
    });
    const serializer = new serialize.SerializeAddon();
    mirror.loadAddon(serializer);
    return {
      info,
      mirror,
      serializer,
      output: new OutputBuffer(this.outputBytes),
      readers: new Map(),
      writerUntil: 0,
      pending: Promise.resolve(),
      recordingText: "",
      generation: 0,
    };
  }
  private changed(session: Session) {
    this.state.session(session.info);
    this.emit({ type: "session.state", id: session.info.id, targetId: session.info.targetId });
  }
  private get(actor: Actor, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) fault("NOT_FOUND", "Session is no longer retained.");
    this.authorize(actor, session.info.targetId, "shell");
    return session;
  }
  async create(
    actor: Actor,
    targetId: string,
    options: {
      cols?: number;
      rows?: number;
      tmux?: boolean;
      recording?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const profile = this.authorize(actor, targetId, "shell");
    this.dimensions(options.cols ?? 80, options.rows ?? 24);
    if (options.tmux && profile.shell !== "posix")
      fault("UNSUPPORTED", "tmux requires a Unix target with tmux already installed.");
    if (options.recording && this.vault.status().locked)
      fault("VAULT_LOCKED", "Unlock the vault before starting encrypted recording.");
    if (
      [...this.sessions.values()].filter((s) => s.info.state === "running").length + this.opening >=
      this.maximum
    )
      fault("LIMIT", "Terminal session limit reached.");
    const session = this.make({
      id: id(),
      targetId,
      state: "running",
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      tmux: options.tmux ?? false,
      recording: options.recording ?? false,
      createdAt: now(),
    });
    this.opening++;
    try {
      await this.open(actor, session, false, options.signal);
      this.sessions.set(session.info.id, session);
      this.trim();
      this.changed(session);
      return { ...session.info };
    } catch (error) {
      session.mirror.dispose();
      throw error;
    } finally {
      this.opening--;
    }
  }
  private trim() {
    for (const [id, session] of this.sessions) {
      if (this.sessions.size <= 128) break;
      if (session.info.state !== "running") {
        session.mirror.dispose();
        this.sessions.delete(id);
      }
    }
  }
  private async open(actor: Actor, session: Session, recover: boolean, signal?: AbortSignal) {
    const profile = this.authorize(actor, session.info.targetId, "shell");
    const lease = await this.pool.acquire(actor, session.info.targetId, "shell", signal);
    const window = { cols: session.info.cols, rows: session.info.rows, term: "xterm-256color" };
    try {
      const name = `sm_${session.info.id.replace(/-/g, "")}`;
      if (session.info.tmux) {
        await this.checkTmux(
          lease,
          recover ? `tmux has-session -t ${name}` : "command -v tmux",
          signal,
        );
      }
      await request<ClientChannel>(
        (cb) =>
          session.info.tmux
            ? lease.client.exec(
                `tmux ${recover ? "attach-session -t" : "new-session -s"} ${name}`,
                { pty: window },
                cb,
              )
            : profile.shell === "posix"
              ? lease.client.shell(window, cb)
              : lease.client.exec(
                  profile.shell === "powershell"
                    ? "powershell.exe -NoLogo -NoProfile"
                    : "cmd.exe /d",
                  { pty: window },
                  cb,
                ),
        this.pool.limits.channelTimeout,
        signal,
        (c) => c.close(),
        (channel) => {
          session.lease = lease;
          session.channel = channel;
          session.info.state = "running";
          session.info.reason = undefined;
          const generation = ++session.generation;
          const consume = (data: Buffer) => {
            if (generation !== session.generation) return;
            channel.pause();
            channel.stderr.pause();
            session.pending = session.pending
              .then(() =>
                generation !== session.generation
                  ? undefined
                  : new Promise<void>((resolve, reject) => {
                      const timer = setTimeout(
                        () =>
                          reject(
                            new ManagementError("TIMEOUT", "Terminal mirror update timed out."),
                          ),
                        this.pool.limits.channelTimeout,
                      );
                      timer.unref();
                      session.mirror.write(data, () => {
                        clearTimeout(timer);
                        resolve();
                      });
                    }),
              )
              .then(() => {
                if (generation !== session.generation) return;
                const part = session.output.append(data);
                if (part && session.info.recording && !this.vault.status().locked) {
                  session.recordingText += part.text;
                  if (Buffer.byteLength(session.recordingText) > this.outputBytes)
                    session.recordingText = Buffer.from(session.recordingText)
                      .subarray(-this.outputBytes)
                      .toString("utf8");
                  this.vault.put(`recording:${session.info.id}`, { value: session.recordingText });
                }
                if (part)
                  this.emit({
                    type: "session.output",
                    id: session.info.id,
                    targetId: session.info.targetId,
                    sequence: part.sequence,
                  });
              })
              .catch(() => {
                if (generation !== session.generation) return;
                session.info.reason =
                  "Recording or terminal mirror failed; reconnect the viewer for current status.";
                this.changed(session);
              })
              .finally(() => {
                if (generation === session.generation) {
                  channel.resume();
                  channel.stderr.resume();
                }
              });
          };
          channel.on("data", consume);
          channel.stderr.on("data", consume);
          channel.on("error", () => {
            if (generation === session.generation) {
              session.info.state = session.info.tmux ? "recoverable" : "lost";
              this.changed(session);
            }
          });
          channel.on("close", () => {
            lease.release();
            if (generation === session.generation && session.info.state === "running") {
              session.info.state = "closed";
              session.info.writer = undefined;
              this.changed(session);
            }
          });
        },
      );
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  private async checkTmux(lease: Lease, command: string, signal?: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      let channel: ClientChannel | undefined,
        code: number | undefined,
        done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        channel?.close();
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new ManagementError("CANCELLED", "tmux check cancelled."));
      const timer = setTimeout(
        () => finish(new ManagementError("TIMEOUT", "tmux check timed out.")),
        this.pool.limits.channelTimeout,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      lease.client.exec(command, (error, opened) => {
        if (done) {
          opened?.close();
          return;
        }
        if (error) {
          finish(new ManagementError("SSH_REQUEST_FAILED", "tmux check failed."));
          return;
        }
        channel = opened;
        channel.on("exit", (c) => {
          code = c;
        });
        channel.on("data", () => {});
        channel.stderr.on("data", () => {});
        channel.on("error", () =>
          finish(new ManagementError("SSH_REQUEST_FAILED", "tmux check failed.")),
        );
        channel.on("close", () =>
          finish(
            code === 0
              ? undefined
              : new ManagementError(
                  "TMUX_UNAVAILABLE",
                  "tmux or the previous remote session is unavailable.",
                ),
          ),
        );
      });
    });
  }

  async attach(actor: Actor, sessionId: string, cursor?: number) {
    const session = this.get(actor, sessionId);
    if (!session.readers.has(actor.id) && session.readers.size >= 16)
      fault("LIMIT", "Session reader limit reached.");
    session.readers.set(actor.id, Date.now() + 60000);
    // Serialize snapshot and cursor within the same queue that commits mirrored output.
    const snapshot = session.pending.then(() => {
      this.get(actor, sessionId);
      const page = session.output.page(cursor ?? 0);
      return {
        session: { ...session.info },
        snapshot: cursor === undefined || page.gap ? session.serializer.serialize() : "",
        cursor: page.cursor,
        output:
          cursor === undefined || page.gap
            ? { parts: [], cursor: page.cursor, gap: page.gap }
            : page,
        recordingPaused: session.info.recording && this.vault.status().locked,
      };
    });
    session.pending = snapshot.then(
      () => {},
      () => {},
    );
    return snapshot;
  }
  read(actor: Actor, sessionId: string, cursor = 0) {
    const s = this.get(actor, sessionId);
    return { session: { ...s.info }, output: s.output.page(cursor) };
  }
  detach(actor: Actor, sessionId: string) {
    const s = this.get(actor, sessionId);
    this.detachInternal(s, actor.id);
    return { ...s.info };
  }
  private detachInternal(s: Session, actorId: string) {
    s.readers.delete(actorId);
    if (s.info.writer === actorId) {
      s.info.writer = undefined;
      s.writerUntil = 0;
      this.changed(s);
    }
  }
  detachActor(actorId: string) {
    for (const s of this.sessions.values()) this.detachInternal(s, actorId);
  }
  writer(actor: Actor, sessionId: string, force = false) {
    const s = this.get(actor, sessionId);
    if (s.info.state !== "running")
      fault("SESSION_LOST", "Session is not running; explicitly recover tmux or create a new PTY.");
    if (!s.readers.has(actor.id))
      fault("NOT_ATTACHED", "Attach before requesting terminal input rights.");
    if (force && actor.kind !== "operator")
      fault("FORBIDDEN", "Only a local operator can force a writer handoff.");
    if (s.info.writer && s.info.writer !== actor.id && s.writerUntil > Date.now() && !force)
      fault("WRITER_BUSY", "Another authenticated client holds the input lease.");
    s.info.writer = actor.id;
    s.writerUntil = Date.now() + 30000;
    s.readers.set(actor.id, Date.now() + 60000);
    this.changed(s);
    return { ...s.info };
  }
  input(actor: Actor, sessionId: string, data: string) {
    const s = this.get(actor, sessionId);
    if (s.info.state !== "running" || !s.channel) fault("SESSION_LOST", "Terminal is not running.");
    if (s.info.writer !== actor.id || s.writerUntil <= Date.now())
      fault("WRITER_REQUIRED", "Acquire the authenticated input lease first.");
    if (typeof data !== "string" || Buffer.byteLength(data) > 16384)
      fault("LIMIT", "Terminal input exceeds its limit.");
    if (s.channel.writableLength > 65536)
      fault("BACKPRESSURE", "Terminal input is backpressured; wait before retrying.");
    s.writerUntil = Date.now() + 30000;
    s.readers.set(actor.id, Date.now() + 60000);
    s.channel.write(data);
    return { accepted: Buffer.byteLength(data) };
  }
  private dimensions(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      cols < 2 ||
      cols > 300 ||
      !Number.isInteger(rows) ||
      rows < 2 ||
      rows > 120
    )
      fault("INVALID_ARGUMENT", "Terminal size is outside its supported range.");
  }
  resize(actor: Actor, sessionId: string, cols: number, rows: number) {
    const s = this.get(actor, sessionId);
    this.dimensions(cols, rows);
    if (s.info.writer !== actor.id || s.writerUntil <= Date.now())
      fault("WRITER_REQUIRED", "Only the current writer may resize a terminal.");
    if (!s.channel || s.info.state !== "running") fault("SESSION_LOST", "Terminal is not running.");
    s.channel.setWindow(rows, cols, 0, 0);
    s.mirror.resize(cols, rows);
    s.info.cols = cols;
    s.info.rows = rows;
    this.changed(s);
    return { ...s.info };
  }
  close(actor: Actor, sessionId: string) {
    const s = this.get(actor, sessionId);
    s.info.state = "closed";
    s.info.writer = undefined;
    s.generation++;
    s.channel?.close();
    s.lease?.release();
    this.changed(s);
    return { ...s.info };
  }
  async recover(actor: Actor, sessionId: string, signal?: AbortSignal) {
    const s = this.get(actor, sessionId);
    if (!s.info.tmux || s.info.state !== "recoverable")
      fault("UNRECOVERABLE", "Only a recoverable tmux session can be reattached.");
    if (
      [...this.sessions.values()].filter((s) => s.info.state === "running").length + this.opening >=
      this.maximum
    )
      fault("LIMIT", "Terminal session limit reached.");
    this.opening++;
    try {
      await this.open(actor, s, true, signal);
      this.changed(s);
      return { ...s.info };
    } finally {
      this.opening--;
    }
  }
  recording(actor: Actor, sessionId: string) {
    const s = this.get(actor, sessionId);
    if (!s.info.recording) fault("NOT_FOUND", "Recording was not enabled.");
    return { text: this.vault.get(`recording:${sessionId}`).value };
  }
  list(actor: Actor, targetId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !targetId || s.info.targetId === targetId)
      .filter((s) => {
        try {
          this.get(actor, s.info.id);
          return true;
        } catch {
          return false;
        }
      })
      .map((s) => ({ ...s.info }));
  }
  shutdown() {
    clearInterval(this.expiry);
    for (const s of this.sessions.values()) {
      if (s.info.state === "running") {
        s.info.state = s.info.tmux ? "recoverable" : "lost";
        s.info.writer = undefined;
        this.changed(s);
      }
      s.generation++;
      s.channel?.close();
      s.lease?.release();
      s.mirror.dispose();
    }
  }
}
