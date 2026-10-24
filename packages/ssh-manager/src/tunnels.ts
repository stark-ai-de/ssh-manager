import net from "node:net";
import type { ClientChannel } from "ssh2";
import {
  fault,
  ManagementError,
  endpoint,
  parse,
  type Actor,
  type Capability,
  type Profile,
  type TunnelInput,
  type TunnelInfo,
  type ManagerEvent,
} from "./contracts.js";
import { ConnectionPool, type Lease } from "./connections.js";
import { id, request, aborted, authorizedResourceInfo } from "./util.js";
import { acceptSocks, connectSocket } from "./proxy.js";

type Tunnel = {
  info: TunnelInfo;
  actor: Actor;
  lease?: Lease;
  server?: net.Server;
  sockets: Set<net.Socket | ClientChannel>;
  remoteHandler?: (...args: any[]) => void;
  retry?: ReturnType<typeof setTimeout>;
  attempts: number;
  generation: number;
  pending: number;
  remoteBound: boolean;
  opening?: AbortController;
};
export class Tunnels {
  private tunnels = new Map<string, Tunnel>();
  private closed = false;
  constructor(
    private pool: ConnectionPool,
    private authorize: (actor: Actor, id: string, cap: Capability) => Profile,
    private emit: (event: ManagerEvent) => void,
    private maximum: number,
  ) {
    pool.on("lost", (connectionId: string) => {
      for (const tunnel of this.tunnels.values())
        if (tunnel.lease?.info.id === connectionId && tunnel.info.state === "running") {
          this.cleanup(tunnel);
          tunnel.info.state = "interrupted";
          this.changed(tunnel);
          if (tunnel.info.reconnect) this.schedule(tunnel);
        }
    });
  }
  private changed(tunnel: Tunnel) {
    this.emit({ type: "tunnel.state", id: tunnel.info.id, targetId: tunnel.info.targetId });
  }
  async create(actor: Actor, targetId: string, input: TunnelInput, signal?: AbortSignal) {
    this.authorize(actor, targetId, "tunnel");
    if (
      !["local", "remote", "socks"].includes(input.kind) ||
      !Number.isInteger(input.listenPort) ||
      input.listenPort < 0 ||
      input.listenPort > 65535
    )
      fault("INVALID_ARGUMENT", "Invalid tunnel kind or listener port.");
    if (input.kind !== "socks") {
      parse(endpoint, input.destinationHost);
      if (
        !Number.isInteger(input.destinationPort) ||
        input.destinationPort! < 1 ||
        input.destinationPort! > 65535
      )
        fault("INVALID_ARGUMENT", "A forwarding destination port is required.");
    }
    if (
      [...this.tunnels.values()].filter((t) => !["closed", "failed"].includes(t.info.state))
        .length >= this.maximum
    )
      fault("LIMIT", "Tunnel limit reached.");
    const tunnel: Tunnel = {
      info: { ...input, id: id(), targetId, state: "interrupted" },
      actor,
      sockets: new Set(),
      attempts: 0,
      generation: 0,
      pending: 0,
      remoteBound: false,
    };
    this.tunnels.set(tunnel.info.id, tunnel);
    try {
      await this.open(tunnel, signal);
      this.trim();
      return { ...tunnel.info };
    } catch (error) {
      // open owns its attempt's cleanup. A concurrent close or new attempt must
      // not be overwritten by the original create's rejected continuation.
      if (!tunnel.opening && tunnel.info.state === "interrupted") {
        tunnel.info.state = "failed";
        this.changed(tunnel);
      }
      this.trim();
      throw error;
    }
  }
  private trim() {
    for (const [id, tunnel] of this.tunnels) {
      if (this.tunnels.size <= 128) break;
      if (["closed", "failed"].includes(tunnel.info.state)) this.tunnels.delete(id);
    }
  }
  private async open(tunnel: Tunnel, signal?: AbortSignal) {
    this.authorize(tunnel.actor, tunnel.info.targetId, "tunnel");
    if (this.closed) fault("CLOSED", "Tunnel owner is closed.");
    if (tunnel.opening) fault("CONFLICT", "Tunnel setup is still in progress.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    tunnel.opening = controller;
    const generation = ++tunnel.generation;
    try {
      aborted(controller.signal);
      // Reserve the requested local port before a new SSH transport can take it
      // as its own ephemeral source port. Pending listeners never forward traffic.
      if (tunnel.info.kind !== "remote") await this.listen(tunnel, generation, controller.signal);
      aborted(controller.signal);
      const lease = await this.pool.acquire(
        tunnel.actor,
        tunnel.info.targetId,
        "tunnel",
        controller.signal,
      );
      if (controller.signal.aborted || generation !== tunnel.generation || this.closed) {
        lease.release();
        fault("CANCELLED", "Tunnel changed during setup.");
      }
      tunnel.lease = lease;
      if (tunnel.info.kind === "remote") {
        try {
          tunnel.info.listenPort = await request<number>(
            (cb) => lease.client.forwardIn("127.0.0.1", tunnel.info.listenPort, cb),
            this.pool.limits.channelTimeout,
            controller.signal,
          );
        } catch (error) {
          this.pool.discard(lease);
          throw error;
        }
        if (controller.signal.aborted) {
          // The SSH callback may have succeeded immediately before cancellation.
          // Discarding the transport also ends that remote listener.
          this.pool.discard(lease);
          fault("CANCELLED", "Remote tunnel setup was cancelled.");
        }
        if (generation !== tunnel.generation) {
          this.pool.discard(lease);
          fault("CONFLICT", "Tunnel changed during setup.");
        }
        tunnel.remoteBound = true;
        const handler = async (info: any, accept: () => ClientChannel, reject: () => void) => {
          if (
            info.destIP !== "127.0.0.1" ||
            info.destPort !== tunnel.info.listenPort ||
            generation !== tunnel.generation
          )
            return;
          if (tunnel.sockets.size + tunnel.pending >= 64) {
            reject();
            return;
          }
          let release: (() => void) | undefined;
          tunnel.pending++;
          try {
            this.authorize(tunnel.actor, tunnel.info.targetId, "tunnel");
            release = this.pool.reserve(lease);
            const socket = await connectSocket(
              tunnel.info.destinationHost!,
              tunnel.info.destinationPort!,
              this.pool.limits.channelTimeout,
            );
            if (generation !== tunnel.generation) {
              socket.destroy();
              release();
              reject();
              return;
            }
            const channel = accept();
            this.pipe(tunnel, socket, channel, release);
          } catch {
            release?.();
            reject();
          } finally {
            tunnel.pending--;
          }
        };
        tunnel.remoteHandler = handler;
        lease.client.on("tcp connection", handler);
      }
      if (generation !== tunnel.generation) fault("CONFLICT", "Tunnel changed during setup.");
      tunnel.info.state = "running";
      tunnel.info.reason = undefined;
      this.changed(tunnel);
    } catch (error) {
      if (generation === tunnel.generation) this.cleanup(tunnel);
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      if (tunnel.opening === controller) tunnel.opening = undefined;
    }
  }
  private async listen(tunnel: Tunnel, generation: number, signal: AbortSignal) {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      const lease = tunnel.lease;
      if (
        !lease ||
        tunnel.info.state !== "running" ||
        generation !== tunnel.generation ||
        tunnel.sockets.size >= 64
      ) {
        socket.destroy();
        return;
      }
      tunnel.sockets.add(socket);
      socket.once("close", () => tunnel.sockets.delete(socket));
      let release: (() => void) | undefined;
      void (async () => {
        this.authorize(tunnel.actor, tunnel.info.targetId, "tunnel");
        release = this.pool.reserve(lease);
        socket.once("close", release);
        const destination =
          tunnel.info.kind === "socks"
            ? await acceptSocks(socket, this.pool.limits.channelTimeout)
            : { host: tunnel.info.destinationHost!, port: tunnel.info.destinationPort! };
        const channel = await request<ClientChannel>(
          (cb) =>
            lease.client.forwardOut(
              "127.0.0.1",
              socket.remotePort ?? 0,
              destination.host,
              destination.port,
              cb,
            ),
          this.pool.limits.channelTimeout,
          undefined,
          (c) => c.destroy(),
        );
        if (generation !== tunnel.generation) {
          channel.destroy();
          socket.destroy();
          return;
        }
        if (tunnel.info.kind === "socks")
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        this.pipe(tunnel, socket, channel, release);
      })().catch(() => {
        release?.();
        socket.destroy();
      });
    });
    tunnel.server = server;
    server.on("error", () => {
      if (tunnel.info.state === "running") {
        this.cleanup(tunnel);
        tunnel.info.state = "failed";
        tunnel.info.reason = "Tunnel listener failed.";
        this.changed(tunnel);
      }
    });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: ManagementError) => {
        server.off("error", failure);
        server.off("listening", ready);
        signal.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const failure = () =>
        finish(new ManagementError("PORT_UNAVAILABLE", "Tunnel listener port is unavailable."));
      const cancel = () => finish(new ManagementError("CANCELLED", "Tunnel setup was cancelled."));
      const ready = () => finish();
      server.once("error", failure);
      server.once("listening", ready);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else server.listen(tunnel.info.listenPort, "127.0.0.1");
    });
    aborted(signal);
    tunnel.info.listenPort = (server.address() as net.AddressInfo).port;
  }
  private pipe(tunnel: Tunnel, socket: net.Socket, channel: ClientChannel, release: () => void) {
    tunnel.sockets.add(socket);
    tunnel.sockets.add(channel);
    const finish = () => {
      release();
      socket.destroy();
      channel.destroy();
      tunnel.sockets.delete(socket);
      tunnel.sockets.delete(channel);
    };
    socket.on("error", finish);
    channel.on("error", finish);
    socket.once("close", finish);
    channel.once("close", finish);
    socket.pipe(channel).pipe(socket);
    socket.resume();
  }
  private cleanup(tunnel: Tunnel) {
    tunnel.opening?.abort();
    tunnel.generation++;
    if (tunnel.retry) clearTimeout(tunnel.retry);
    for (const socket of tunnel.sockets) socket.destroy();
    tunnel.sockets.clear();
    tunnel.server?.close();
    tunnel.server = undefined;
    if (tunnel.remoteHandler && tunnel.lease)
      tunnel.lease.client.off("tcp connection", tunnel.remoteHandler as any);
    if (tunnel.remoteBound && tunnel.lease?.info.state === "ready") {
      const lease = tunnel.lease;
      const port = tunnel.info.listenPort;
      void request<void>(
        (cb) => lease.client.unforwardIn("127.0.0.1", port, cb),
        this.pool.limits.channelTimeout,
      ).catch(() => this.pool.discard(lease));
    }
    tunnel.remoteBound = false;
    tunnel.remoteHandler = undefined;
    tunnel.lease?.release();
    tunnel.lease = undefined;
  }
  private schedule(tunnel: Tunnel) {
    if (this.closed || tunnel.info.state === "closed") return;
    if (++tunnel.attempts > 3) {
      tunnel.info.reason = "Reconnect limit reached; explicitly retry after local setup.";
      this.changed(tunnel);
      return;
    }
    tunnel.retry = setTimeout(() => {
      void this.open(tunnel).catch(() => {
        if (
          this.closed ||
          tunnel.info.state === "closed" ||
          tunnel.info.state === "running" ||
          tunnel.opening
        )
          return;
        tunnel.info.state = "interrupted";
        tunnel.info.reason =
          "Reconnect requires working credentials, permission and trusted host keys.";
        this.changed(tunnel);
        if (tunnel.info.reconnect) this.schedule(tunnel);
      });
    }, 1000 * tunnel.attempts);
    tunnel.retry.unref();
  }
  private get(actor: Actor, tunnelId: string) {
    const t = this.tunnels.get(tunnelId);
    if (!t) fault("NOT_FOUND", "Tunnel does not exist.");
    this.authorize(actor, t.info.targetId, "tunnel");
    return t;
  }
  list(actor: Actor, targetId?: string) {
    return authorizedResourceInfo(
      this.tunnels.values(),
      (info) => this.get(actor, info.id),
      targetId,
    );
  }
  async close(actor: Actor, tunnelId: string) {
    const t = this.get(actor, tunnelId);
    t.info.state = "closed";
    if (t.info.kind === "remote" && t.lease && t.lease.info.state === "ready") {
      const lease = t.lease;
      t.remoteBound = false;
      try {
        await request<void>(
          (cb) => lease.client.unforwardIn("127.0.0.1", t.info.listenPort, cb),
          this.pool.limits.channelTimeout,
        );
      } catch (error) {
        this.pool.discard(lease);
        throw error;
      } finally {
        this.cleanup(t);
        this.changed(t);
      }
    } else {
      this.cleanup(t);
      this.changed(t);
    }
    return { ...t.info };
  }
  async reconnect(actor: Actor, tunnelId: string, signal?: AbortSignal) {
    const t = this.get(actor, tunnelId);
    if (t.opening) fault("CONFLICT", "Tunnel setup is still in progress.");
    if (t.info.state === "running")
      fault("CONFLICT", "Close a running tunnel before reconnecting it.");
    this.cleanup(t);
    t.attempts = 0;
    t.actor = actor;
    await this.open(t, signal);
    return { ...t.info };
  }
  shutdown() {
    this.closed = true;
    for (const t of this.tunnels.values()) {
      t.info.state = "closed";
      this.cleanup(t);
    }
  }
}
