import { EventEmitter } from "node:events";
import ssh2, { type Client, type ClientChannel, type ConnectConfig } from "ssh2";
const { Client: SSHClient } = ssh2;
import {
  fault,
  ManagementError,
  type Actor,
  type Capability,
  type Profile,
  type ConnectionInfo,
  type ConnectionLimits,
} from "./contracts.js";
import { StateStore } from "./state.js";
import { HostTrust, fingerprint } from "./trust.js";
import type { CredentialProvider } from "./credentials.js";
import { Vault } from "./vault.js";
import { id, now, aborted, request } from "./util.js";
import { proxySocket } from "./proxy.js";

export type Lease = { client: Client; info: ConnectionInfo; release(): void };
export type { ConnectionLimits } from "./contracts.js";
type Entry = {
  client: Client;
  chain: Client[];
  info: ConnectionInfo;
  dependencies: string[];
  key: string;
  lastUsed: number;
};
export class ConnectionPool extends EventEmitter {
  private entries = new Map<string, Entry>();
  private pending = new Map<
    string,
    { targetId: string; dependencies: string[]; controller: AbortController }
  >();
  private waiters = 0;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private trustTimer: ReturnType<typeof setInterval>;
  private trustSnapshot?: string;
  constructor(
    private state: StateStore,
    private trust: HostTrust,
    private provider: CredentialProvider,
    private vault: Vault,
    readonly limits: ConnectionLimits,
    private authorize: (actor: Actor, targetId: string, cap: Capability) => Profile,
  ) {
    super();
    this.setMaxListeners(limits.waiters + limits.connections * 2 + 16);
    this.timer = setInterval(
      () => {
        for (const [id, entry] of this.entries)
          if (!entry.info.channels && Date.now() - entry.lastUsed > limits.idleTimeout)
            this.closeEntry(id);
      },
      Math.min(limits.idleTimeout, 30000),
    );
    this.timer.unref();
    this.trustTimer = setInterval(() => {
      try {
        this.refreshTrust();
      } catch {
        this.invalidate(new Set(this.state.data.profiles.map((p) => p.id)));
      }
    }, 1000);
    this.trustTimer.unref();
  }
  private refreshTrust() {
    const snapshot = this.trust.snapshot();
    if (this.trustSnapshot !== undefined && this.trustSnapshot !== snapshot)
      this.invalidate(new Set(this.state.data.profiles.map((p) => p.id)));
    this.trustSnapshot = snapshot;
  }
  private route(actor: Actor, targetId: string, cap: Capability) {
    const target = this.authorize(actor, targetId, cap);
    const profiles = target.jumpIds.map((id) => this.authorize(actor, id, "connect"));
    if (
      profiles.length > 4 ||
      new Set([...profiles.map((p) => p.id), targetId]).size !== profiles.length + 1
    )
      fault("INVALID_ROUTE", "Jump chain contains a loop or too many hops.");
    if (profiles.some((p) => p.jumpIds.length || p.proxy))
      fault(
        "INVALID_ROUTE",
        "Jump IDs describe a flat explicit chain; nested routes are unsupported.",
      );
    return [...profiles, target];
  }
  private key(profiles: Profile[]) {
    const state = this.state.data;
    return JSON.stringify(
      profiles.map((p) => ({
        profile: {
          id: p.id,
          host: p.host,
          port: p.port,
          username: p.username,
          credentialId: p.credentialId,
          jumpIds: p.jumpIds,
          proxy: p.proxy,
        },
        credential: state.credentials.find((c) => c.id === p.credentialId),
        pins: state.pins.filter((pin) => pin.profileId === p.id).map(({ revision, ...pin }) => pin),
      })),
    );
  }
  async acquire(
    actor: Actor,
    targetId: string,
    cap: Capability = "connect",
    signal?: AbortSignal,
  ): Promise<Lease> {
    const deadline = Date.now() + this.limits.channelTimeout;
    while (true) {
      aborted(signal);
      if (this.closed) fault("CLOSED", "Connection pool is closed.");
      this.refreshTrust();
      const profiles = this.route(actor, targetId, cap);
      const key = this.key(profiles);
      const available = [...this.entries.values()].find(
        (e) =>
          e.info.targetId === targetId && e.key === key && e.info.channels < this.limits.channels,
      );
      if (available) return this.lease(available);
      const pending = [...this.pending.values()];
      const entries = [...this.entries.values()];
      const transports =
        entries.reduce((count, entry) => count + entry.chain.length, 0) +
        pending.reduce((count, attempt) => count + attempt.dependencies.length, 0);
      const saturated = profiles
        .filter(
          (profile) =>
            entries.filter((entry) => entry.dependencies.includes(profile.id)).length +
              pending.filter((attempt) => attempt.dependencies.includes(profile.id)).length >=
            this.limits.perTarget,
        )
        .map((profile) => profile.id);
      if (profiles.length > this.limits.connections)
        fault("LIMIT", "Jump route exceeds the transport connection budget.");
      if (!saturated.length && transports + profiles.length <= this.limits.connections) {
        const attempt = id();
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        this.pending.set(attempt, {
          targetId,
          dependencies: profiles.map((p) => p.id),
          controller,
        });
        try {
          const entry = await this.connect(profiles, controller.signal);
          // Recheck after authentication, before the late factory can enter the pool.
          try {
            this.refreshTrust();
            if (
              controller.signal.aborted ||
              this.closed ||
              key !== this.key(this.route(actor, targetId, cap))
            )
              fault("CONFLICT", "Target or credentials changed during authentication.");
          } catch (error) {
            this.dispose(entry);
            throw error;
          }
          entry.key = key;
          this.entries.set(entry.info.id, entry);
          for (const client of entry.chain)
            client.once("close", () => this.closeEntry(entry.info.id));
          return this.lease(entry);
        } finally {
          this.pending.delete(attempt);
          signal?.removeEventListener("abort", cancel);
          this.emit("available");
        }
      }
      const idle = entries
        .filter(
          (entry) =>
            !entry.info.channels &&
            (!saturated.length || entry.dependencies.some((id) => saturated.includes(id))),
        )
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (idle) {
        this.closeEntry(idle.info.id);
        continue;
      }
      if (this.waiters >= this.limits.waiters) fault("LIMIT", "Connection wait queue is full.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) fault("TIMEOUT", "Timed out waiting for a connection slot.");
      this.waiters++;
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(timer);
            this.off("available", ready);
            signal?.removeEventListener("abort", cancel);
            error ? reject(error) : resolve();
          };
          const ready = () => finish();
          const cancel = () =>
            finish(new ManagementError("CANCELLED", "Connection wait cancelled."));
          const timer = setTimeout(
            () => finish(new ManagementError("TIMEOUT", "Connection wait timed out.")),
            remaining,
          );
          this.once("available", ready);
          signal?.addEventListener("abort", cancel, { once: true });
        });
      } finally {
        this.waiters--;
      }
    }
  }
  private lease(entry: Entry): Lease {
    entry.info.channels++;
    let released = false;
    return {
      client: entry.client,
      info: entry.info,
      release: () => {
        if (released) return;
        released = true;
        entry.info.channels--;
        entry.lastUsed = Date.now();
        this.emit("available");
      },
    };
  }
  private async connect(profiles: Profile[], signal: AbortSignal, inspect = false) {
    const chain: Client[] = [];
    let socket: any;
    let observed: { key: string; fingerprint: string } | undefined;
    const target = profiles.at(-1)!;
    try {
      if (target.proxy) {
        const ref =
          target.proxy.credentialId &&
          this.state.data.credentials.find((c) => c.id === target.proxy!.credentialId);
        const secret = ref ? await this.provider.resolve(ref, signal) : undefined;
        socket = await proxySocket(
          target.proxy,
          profiles[0]!.host,
          profiles[0]!.port,
          this.limits.authTimeout,
          signal,
          secret?.password,
        );
      }
      for (const [index, profile] of profiles.entries()) {
        aborted(signal);
        if (index)
          socket = await request<ClientChannel>(
            (cb) => chain[index - 1]!.forwardOut("127.0.0.1", 0, profile.host, profile.port, cb),
            this.limits.channelTimeout,
            signal,
            (c) => c.destroy(),
          );
        const inspecting = inspect && profile.id === target.id;
        const reference =
          profile.credentialId &&
          this.state.data.credentials.find((c) => c.id === profile.credentialId);
        if (!inspecting && !reference)
          fault("CREDENTIAL_REQUIRED", "Assign an existing credential through local setup.");
        const authentication: ConnectConfig = inspecting
          ? {}
          : await this.provider.resolve(reference as any, signal);
        const client = new SSHClient();
        chain.push(client);
        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false;
            let verificationError: unknown;
            const cancel = () =>
              finish(new ManagementError("CANCELLED", "SSH authentication cancelled."));
            const timer = setTimeout(
              () => finish(new ManagementError("TIMEOUT", "SSH authentication timed out.")),
              this.limits.authTimeout,
            );
            const finish = (error?: Error) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal.removeEventListener("abort", cancel);
              error ? reject(error) : resolve();
            };
            signal.addEventListener("abort", cancel, { once: true });
            client.on("error", () =>
              finish(
                verificationError instanceof ManagementError
                  ? verificationError
                  : new ManagementError(
                      "AUTHENTICATION_FAILED",
                      "SSH authentication or handshake failed.",
                    ),
              ),
            );
            client.once("close", () =>
              finish(
                new ManagementError(
                  "CONNECTION_FAILED",
                  "SSH closed before authentication completed.",
                ),
              ),
            );
            client.once("ready", () => finish());
            client.connect({
              host: profile.host,
              port: profile.port,
              username: profile.username,
              ...authentication,
              ...(socket ? { sock: socket } : {}),
              readyTimeout: this.limits.authTimeout,
              keepaliveInterval: 15000,
              keepaliveCountMax: 3,
              hostVerifier: (key: Buffer) => {
                if (inspecting) {
                  observed = { key: key.toString("base64"), fingerprint: fingerprint(key) };
                  return false;
                }
                try {
                  return this.trust.verify(profile, key);
                } catch (error) {
                  verificationError = error;
                  return false;
                }
              },
            });
          });
        } catch (error) {
          if (!(inspecting && observed)) throw error;
        } finally {
          if (Buffer.isBuffer(authentication.privateKey)) authentication.privateKey.fill(0);
        }
      }
      if (inspect) {
        for (const client of chain) client.destroy();
        return observed as any;
      }
      const info: ConnectionInfo = {
        id: id(),
        targetId: target.id,
        state: "ready",
        channels: 0,
        createdAt: now(),
      };
      return {
        client: chain.at(-1)!,
        chain,
        info,
        dependencies: profiles.map((p) => p.id),
        key: "",
        lastUsed: Date.now(),
      } as Entry;
    } catch (error) {
      for (const client of chain.reverse()) client.destroy();
      socket?.destroy();
      throw error;
    }
  }
  async inspect(
    actor: Actor,
    target: Profile,
    signal?: AbortSignal,
  ): Promise<{ key: string; fingerprint: string }> {
    const jumps = target.jumpIds.map((id) => this.authorize(actor, id, "connect"));
    if (
      jumps.some((p) => p.jumpIds.length || p.proxy) ||
      new Set([...jumps.map((p) => p.id), target.id]).size !== jumps.length + 1
    )
      fault("INVALID_ROUTE", "Invalid jump chain.");
    aborted(signal);
    if (this.closed) fault("CLOSED", "Connection pool is closed.");
    const profiles = [...jumps, target],
      entries = [...this.entries.values()],
      pending = [...this.pending.values()];
    if (
      entries.reduce((count, entry) => count + entry.chain.length, 0) +
        pending.reduce((count, attempt) => count + attempt.dependencies.length, 0) +
        profiles.length >
        this.limits.connections ||
      profiles.some(
        (profile) =>
          entries.filter((entry) => entry.dependencies.includes(profile.id)).length +
            pending.filter((attempt) => attempt.dependencies.includes(profile.id)).length >=
          this.limits.perTarget,
      )
    )
      fault("LIMIT", "Host inspection connection budget reached.");
    const attempt = id(),
      controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.pending.set(attempt, {
      targetId: target.id,
      dependencies: profiles.map((p) => p.id),
      controller,
    });
    try {
      const observed = await this.connect(profiles, controller.signal, true);
      aborted(controller.signal);
      return observed as any;
    } finally {
      this.pending.delete(attempt);
      signal?.removeEventListener("abort", cancel);
      this.emit("available");
    }
  }
  list(actor: Actor) {
    return [...this.entries.values()]
      .filter((e) => {
        try {
          this.authorize(actor, e.info.targetId, "connect");
          return true;
        } catch {
          return false;
        }
      })
      .map((e) => ({ ...e.info }));
  }
  close(actor: Actor, connectionId: string) {
    const entry = this.entries.get(connectionId);
    if (!entry) fault("NOT_FOUND", "Connection does not exist.");
    this.authorize(actor, entry.info.targetId, "connect");
    this.closeEntry(connectionId);
  }
  reserve(lease: Lease) {
    const entry = this.entries.get(lease.info.id);
    if (!entry || entry.info.channels >= this.limits.channels)
      fault("LIMIT", "Connection channel limit reached.");
    const reservation = this.lease(entry);
    return () => reservation.release();
  }
  discard(lease: Lease) {
    this.closeEntry(lease.info.id);
  }
  invalidate(targetIds: Set<string>) {
    for (const pending of this.pending.values())
      if (pending.dependencies.some((id) => targetIds.has(id))) pending.controller.abort();
    for (const [id, entry] of this.entries)
      if (entry.dependencies.some((id) => targetIds.has(id))) this.closeEntry(id);
    this.emit("available");
  }
  suspendVaultAuthentication() {
    const state = this.state.data;
    const usesVault = (targetId: string) => {
      const profile = state.profiles.find((p) => p.id === targetId);
      return state.credentials.some(
        (c) =>
          (c.id === profile?.credentialId || c.id === profile?.proxy?.credentialId) &&
          (c.kind === "vault" || ("passphraseId" in c && !!c.passphraseId)),
      );
    };
    for (const pending of this.pending.values())
      if (pending.dependencies.some(usesVault)) pending.controller.abort();
  }
  private dispose(entry: Entry) {
    for (const client of [...entry.chain].reverse()) client.destroy();
  }
  private closeEntry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.info.state = "closed";
    this.dispose(entry);
    this.emit("lost", id, entry.info.targetId);
    this.emit("available");
  }
  shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.trustTimer);
    for (const p of this.pending.values()) p.controller.abort();
    for (const id of this.entries.keys()) this.closeEntry(id);
    this.emit("available");
  }
}
