import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  parse,
  profileInput,
  credentialInput,
  capabilities,
  requireOperator,
  fault,
  type Actor,
  type Capability,
  type Profile,
  type ProfileInput,
  type CredentialRef,
  type CredentialSecret,
  type ManagerEvent,
  type ConnectionLimits,
} from "./contracts.js";
import { id, privateDirectory } from "./util.js";
import { StateStore } from "./state.js";
import { Vault } from "./vault.js";
import { HostTrust } from "./trust.js";
import { LocalCredentialProvider, type CredentialProvider } from "./credentials.js";
import { ConnectionPool } from "./connections.js";
import type { SessionAPI, JobAPI, FileAPI, TunnelAPI } from "./public-api.js";
import { Sessions } from "./sessions.js";
import { Jobs } from "./jobs.js";
import { Files } from "./files.js";
import { Tunnels } from "./tunnels.js";
import { previewSshConfig } from "./ssh-config.js";

export type ManagerOptions = {
  stateDirectory: string;
  knownHosts?: string[];
  credentialProvider?: CredentialProvider;
  limits?: Partial<
    ConnectionLimits & {
      sessions: number;
      jobs: number;
      transfers: number;
      tunnels: number;
      outputBytes: number;
      fileBytes: number;
    }
  >;
};
export type CredentialInput = z.infer<typeof credentialInput>;
export class SSHManager extends EventEmitter {
  private store: StateStore;
  private vault: Vault;
  private pool: ConnectionPool;
  private owner: string;
  private ownerFile: string;
  private closed = false;
  private sessionService: Sessions;
  private jobService: Jobs;
  private fileService: Files;
  private tunnelService: Tunnels;
  readonly sessions: SessionAPI;
  readonly jobs: JobAPI;
  readonly files: FileAPI;
  readonly tunnels: TunnelAPI;
  constructor(options: ManagerOptions) {
    super();
    this.setMaxListeners(128);
    privateDirectory(options.stateDirectory);
    this.owner = id();
    this.ownerFile = path.join(options.stateDirectory, "owner.json");
    this.claim();
    try {
      this.store = new StateStore(options.stateDirectory);
      this.vault = new Vault(options.stateDirectory);
      const limits = {
        connections: 16,
        perTarget: 3,
        channels: 8,
        waiters: 32,
        authTimeout: 20000,
        channelTimeout: 15000,
        idleTimeout: 600000,
        sessions: 16,
        jobs: 32,
        transfers: 4,
        tunnels: 16,
        outputBytes: 1024 * 1024,
        fileBytes: 100 * 1024 * 1024,
        ...options.limits,
      };
      const maxima = {
        connections: 128,
        perTarget: 16,
        channels: 64,
        waiters: 256,
        authTimeout: 300000,
        channelTimeout: 300000,
        idleTimeout: 86400000,
        sessions: 64,
        jobs: 128,
        transfers: 32,
        tunnels: 64,
        outputBytes: 8 * 1024 * 1024,
        fileBytes: 1024 * 1024 * 1024,
      };
      for (const name of Object.keys(limits) as (keyof typeof limits)[])
        if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > maxima[name])
          fault("INVALID_ARGUMENT", `Invalid resource limit: ${name}.`);
      const authorize = (actor: Actor, targetId: string, cap: Capability) =>
        this.authorize(actor, targetId, cap);
      const emit = (event: ManagerEvent) => this.emit("event", event);
      this.pool = new ConnectionPool(
        this.store,
        new HostTrust(
          this.store,
          options.knownHosts ?? [path.join(os.homedir(), ".ssh", "known_hosts")],
        ),
        options.credentialProvider ?? new LocalCredentialProvider(this.store, this.vault),
        this.vault,
        limits,
        authorize,
      );
      this.sessionService = new Sessions(
        this.pool,
        this.store,
        this.vault,
        authorize,
        emit,
        limits.sessions,
        limits.outputBytes,
      );
      this.sessions = this.audited(this.sessionService, "session", [
        "create",
        "writer",
        "input",
        "resize",
        "close",
        "recover",
      ]);
      this.jobService = new Jobs(this.pool, authorize, emit, limits.jobs, limits.outputBytes);
      this.jobs = this.audited(this.jobService, "job", ["start", "cancel", "group"]);
      this.fileService = new Files(this.pool, authorize, limits.transfers, limits.fileBytes);
      this.files = this.audited(this.fileService, "file", ["mutate", "upload"]);
      this.tunnelService = new Tunnels(this.pool, authorize, emit, limits.tunnels);
      this.tunnels = this.audited(this.tunnelService, "tunnel", ["create", "close", "reconnect"]);
    } catch (error) {
      this.releaseOwner();
      throw error;
    }
  }
  private audited<T extends object>(service: T, scope: string, operations: string[]): T {
    return new Proxy(service, {
      get: (target, key) => {
        const value = target[key as keyof T];
        if (typeof value !== "function") return value;
        if (!operations.includes(String(key))) return value.bind(target);
        return (actor: Actor, ...args: unknown[]) => {
          const record = (outcome: string, result?: any) => {
            if (!this.closed)
              this.store.audit(
                actor.id,
                `${scope}.${String(key)}`,
                outcome,
                typeof result?.targetId === "string" ? result.targetId : undefined,
              );
          };
          try {
            const result = value.apply(target, [actor, ...args]);
            if (result instanceof Promise)
              return result.then(
                (data) => {
                  record("completed", data);
                  return data;
                },
                (error) => {
                  record("failed");
                  throw error;
                },
              );
            record("completed", result);
            return result;
          } catch (error) {
            record("failed");
            throw error;
          }
        };
      },
    });
  }
  private claim() {
    try {
      fs.writeFileSync(this.ownerFile, JSON.stringify({ pid: process.pid, owner: this.owner }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: { pid: number };
      try {
        previous = JSON.parse(fs.readFileSync(this.ownerFile, "utf8"));
        if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error();
      } catch {
        fault(
          "STATE_BUSY",
          "State ownership marker is invalid; inspect it locally before recovery.",
        );
      }
      try {
        process.kill(previous.pid, 0);
        fault("STATE_BUSY", "Another live manager owns this state directory.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      fs.unlinkSync(this.ownerFile);
      fs.writeFileSync(this.ownerFile, JSON.stringify({ pid: process.pid, owner: this.owner }), {
        flag: "wx",
        mode: 0o600,
      });
    }
  }
  private releaseOwner() {
    try {
      if (JSON.parse(fs.readFileSync(this.ownerFile, "utf8")).owner === this.owner)
        fs.unlinkSync(this.ownerFile);
    } catch {
      /* Do not remove a marker whose ownership changed. */
    }
  }
  private profile(targetId: string) {
    const profile = this.store.data.profiles.find((p) => p.id === targetId);
    if (!profile) fault("NOT_FOUND", "Target profile does not exist.");
    return profile;
  }
  private authorize(actor: Actor, targetId: string, cap: Capability): Profile {
    if (this.closed) fault("CLOSED", "SSH manager is closed.");
    const profile = this.profile(targetId);
    const grant = this.store.data.grants[targetId];
    if (
      !grant ||
      grant.revision !== profile.revision ||
      !grant.capabilities.includes(cap) ||
      !grant.capabilities.includes("connect")
    ) {
      this.store.audit(actor.id, cap, "denied", targetId);
      fault("FORBIDDEN", "The operator has not granted this target capability.", {
        targetId,
        capability: cap,
      });
    }
    return profile;
  }
  private invalidation(targetId: string) {
    const affected = new Set([targetId]);
    for (const profile of this.store.data.profiles)
      if (profile.jumpIds.includes(targetId)) affected.add(profile.id);
    this.store.change((d) => {
      for (const id of affected) delete d.grants[id];
    });
    this.pool.invalidate(affected);
  }
  profiles(_actor: Actor, query: { search?: string; group?: string } = {}) {
    return this.store.data.profiles.filter(
      (p) =>
        (!query.group || p.groups.includes(query.group)) &&
        (!query.search ||
          `${p.name} ${p.host} ${p.username}`.toLowerCase().includes(query.search.toLowerCase())),
    );
  }
  createProfile(actor: Actor, input: ProfileInput) {
    const profile = parse(profileInput, input);
    if (
      actor.kind !== "operator" &&
      (profile.credentialId || profile.proxy || profile.jumpIds.length)
    )
      fault("FORBIDDEN", "An operator must assign credentials or connection routes.");
    this.validateReferences(profile);
    const result: Profile = { ...profile, id: id(), revision: 1 };
    this.store.change((d) => {
      if (d.profiles.length >= 256) fault("LIMIT", "Host profile limit reached.");
      d.profiles.push(result);
    });
    this.store.audit(actor.id, "profile.create", "completed", result.id);
    return result;
  }
  private validateReferences(profile: z.infer<typeof profileInput>) {
    const state = this.store.data;
    if (profile.credentialId && !state.credentials.some((c) => c.id === profile.credentialId))
      fault("NOT_FOUND", "Assigned credential does not exist.");
    if (
      profile.proxy?.credentialId &&
      !state.credentials.some(
        (c) =>
          c.id === profile.proxy!.credentialId && c.kind === "vault" && c.secretKind === "password",
      )
    )
      fault(
        "INVALID_CREDENTIAL",
        "Proxy authentication requires an existing vault password reference.",
      );
    for (const id of profile.jumpIds)
      if (!state.profiles.some((p) => p.id === id))
        fault("NOT_FOUND", "Jump target does not exist.");
    for (const root of profile.fileRoots)
      if (!root.startsWith("/") || root.split("/").includes("..") || /[\\\x00-\x1f]/.test(root))
        fault("INVALID_ARGUMENT", "File roots must be absolute canonical SFTP paths.");
  }
  updateProfile(actor: Actor, targetId: string, expectedRevision: number, input: ProfileInput) {
    const previous = this.profile(targetId);
    if (previous.revision !== expectedRevision)
      fault("CONFLICT", "Profile revision changed; reload before editing.");
    const next = parse(profileInput, input);
    this.validateReferences(next);
    const sensitive = [
      "host",
      "port",
      "username",
      "credentialId",
      "shell",
      "jumpIds",
      "proxy",
      "fileRoots",
    ] as const;
    const changed = sensitive.some(
      (key) => JSON.stringify(next[key]) !== JSON.stringify(previous[key]),
    );
    if (changed) requireOperator(actor);
    if (next.jumpIds.includes(targetId))
      fault("INVALID_ROUTE", "A target cannot jump through itself.");
    const result: Profile = { ...next, id: targetId, revision: previous.revision + 1 };
    this.store.change((d) => {
      d.profiles[d.profiles.findIndex((p) => p.id === targetId)] = result;
      if (!changed) {
        if (d.grants[targetId]) d.grants[targetId]!.revision = result.revision;
        for (const pin of d.pins.filter((pin) => pin.profileId === targetId))
          pin.revision = result.revision;
      }
    });
    if (changed) this.invalidation(targetId);
    this.store.audit(actor.id, "profile.update", "completed", targetId);
    return result;
  }
  removeProfile(actor: Actor, targetId: string, expectedRevision: number) {
    requireOperator(actor);
    if (this.profile(targetId).revision !== expectedRevision)
      fault("CONFLICT", "Profile revision changed.");
    this.invalidation(targetId);
    this.store.change((d) => {
      d.profiles = d.profiles.filter((p) => p.id !== targetId);
      d.pins = d.pins.filter((p) => p.profileId !== targetId);
    });
    this.store.audit(actor.id, "profile.remove", "completed", targetId);
    return { completed: true };
  }
  exportProfiles(actor: Actor) {
    return { schema: 1 as const, profiles: this.profiles(actor) };
  }
  previewImport(_actor: Actor, text: string) {
    return previewSshConfig(text);
  }
  applyImport(actor: Actor, profiles: ProfileInput[]) {
    requireOperator(actor);
    if (profiles.length > 256 - this.store.data.profiles.length)
      fault("LIMIT", "Import exceeds profile limit.");
    const parsed = profiles.map((p) => parse(profileInput, p));
    for (const p of parsed) this.validateReferences(p);
    const created = parsed.map((p) => ({ ...p, id: id(), revision: 1 }));
    this.store.change((d) => d.profiles.push(...created));
    this.store.audit(actor.id, "profile.import", "completed");
    return created;
  }
  grants(actor: Actor, targetId: string) {
    this.profile(targetId);
    return { targetId, ...this.store.data.grants[targetId] };
  }
  setGrants(actor: Actor, targetId: string, expectedRevision: number, input: Capability[]) {
    requireOperator(actor);
    const profile = this.profile(targetId);
    if (profile.revision !== expectedRevision)
      fault("CONFLICT", "Profile changed before permission confirmation.");
    const caps = parse(capabilities, input);
    this.invalidation(targetId);
    this.store.change((d) => {
      d.grants[targetId] = { revision: profile.revision, capabilities: [...new Set(caps)] };
    });
    this.store.audit(actor.id, "grant.set", "completed", targetId);
    return this.grants(actor, targetId);
  }
  credentials(_actor: Actor) {
    return this.store.data.credentials.map((c) => ({
      id: c.id,
      name: c.name,
      revision: c.revision,
      kind: c.kind,
      ...(c.kind === "vault" ? { secretKind: c.secretKind } : {}),
    }));
  }
  addCredential(actor: Actor, input: CredentialInput, secret?: CredentialSecret) {
    requireOperator(actor);
    const data = parse(credentialInput, input);
    const ref = { ...data, id: id(), revision: 1 } as CredentialRef;
    if (this.store.data.credentials.length >= 256) fault("LIMIT", "Credential limit reached.");
    this.validateCredential(data);
    if (data.kind === "vault") {
      if (!secret || typeof secret.value !== "string")
        fault(
          "INVALID_CREDENTIAL",
          "Vault credential needs secret input through trusted local setup.",
        );
      this.vault.put(ref.id, secret);
    }
    this.store.change((d) => {
      if (d.credentials.length >= 256) fault("LIMIT", "Credential limit reached.");
      d.credentials.push(ref);
    });
    this.store.audit(actor.id, "credential.add", "completed");
    return this.credentials(actor).find((c) => c.id === ref.id)!;
  }
  private validateCredential(data: CredentialInput) {
    if (
      data.kind === "agent" &&
      process.platform === "win32" &&
      !/^\\\\\.\\pipe\\/i.test(data.socket)
    )
      fault(
        "UNSUPPORTED",
        "Use a Windows OpenSSH agent named pipe; Pageant and Cygwin helpers are not bundled.",
      );
    if (data.kind === "key-file" && !path.isAbsolute(data.path))
      fault("INVALID_ARGUMENT", "Private-key file references must be absolute native paths.");
    if (
      "passphraseId" in data &&
      data.passphraseId &&
      !this.store.data.credentials.some(
        (c) => c.id === data.passphraseId && c.kind === "vault" && c.secretKind === "passphrase",
      )
    )
      fault(
        "INVALID_CREDENTIAL",
        "Passphrase reference must identify an existing vault passphrase.",
      );
  }
  updateCredential(
    actor: Actor,
    credentialId: string,
    expectedRevision: number,
    input: CredentialInput,
    secret?: CredentialSecret,
  ) {
    requireOperator(actor);
    const previous = this.store.data.credentials.find((c) => c.id === credentialId);
    if (!previous) fault("NOT_FOUND", "Credential does not exist.");
    if (previous.revision !== expectedRevision)
      fault("CONFLICT", "Credential changed; reload before editing.");
    const data = parse(credentialInput, input);
    this.validateCredential(data);
    if (
      data.kind !== previous.kind ||
      (data.kind === "vault" &&
        previous.kind === "vault" &&
        data.secretKind !== previous.secretKind)
    )
      fault("INVALID_ARGUMENT", "Credential kind is immutable; create a new reference instead.");
    if (secret) {
      if (data.kind !== "vault")
        fault("INVALID_ARGUMENT", "Only vault references accept secret input.");
      this.vault.put(credentialId, secret);
    }
    const dependents = this.store.data.credentials
      .filter(
        (c) => c.id === credentialId || ("passphraseId" in c && c.passphraseId === credentialId),
      )
      .map((c) => c.id);
    for (const p of this.store.data.profiles)
      if (
        (p.credentialId && dependents.includes(p.credentialId)) ||
        (p.proxy?.credentialId && dependents.includes(p.proxy.credentialId))
      )
        this.invalidation(p.id);
    this.store.change((d) => {
      d.credentials[d.credentials.findIndex((c) => c.id === credentialId)] = {
        ...data,
        id: credentialId,
        revision: expectedRevision + 1,
      } as CredentialRef;
    });
    this.store.audit(actor.id, "credential.update", "completed");
    return this.credentials(actor).find((c) => c.id === credentialId)!;
  }
  removeCredential(actor: Actor, credentialId: string) {
    requireOperator(actor);
    const credential = this.store.data.credentials.find((c) => c.id === credentialId);
    if (!credential) fault("NOT_FOUND", "Credential does not exist.");
    const used = this.store.data.profiles.filter(
      (p) =>
        p.credentialId === credentialId ||
        p.proxy?.credentialId === credentialId ||
        this.store.data.credentials.find(
          (c) => c.id === p.credentialId && "passphraseId" in c && c.passphraseId === credentialId,
        ),
    );
    for (const p of used) this.invalidation(p.id);
    if (credential.kind === "vault") this.vault.remove(credentialId);
    this.store.change((d) => {
      d.credentials = d.credentials.filter((c) => c.id !== credentialId);
    });
    this.store.audit(actor.id, "credential.remove", "completed");
    return { completed: true };
  }
  vaultStatus(_actor: Actor) {
    return this.vault.status();
  }
  async vaultInitialize(actor: Actor, password: string) {
    requireOperator(actor);
    await this.vault.initialize(password);
    this.store.audit(actor.id, "vault.initialize", "completed");
    return this.vault.status();
  }
  async vaultUnlock(actor: Actor, password: string) {
    requireOperator(actor);
    await this.vault.unlock(password);
    this.store.audit(actor.id, "vault.unlock", "completed");
    return this.vault.status();
  }
  vaultLock(actor: Actor) {
    requireOperator(actor);
    this.vault.lock();
    this.pool.suspendVaultAuthentication();
    this.store.audit(actor.id, "vault.lock", "completed");
    return this.vault.status();
  }
  async vaultRotate(actor: Actor, previous: string, next: string) {
    requireOperator(actor);
    await this.vault.rotate(previous, next);
    this.store.audit(actor.id, "vault.rotate", "completed");
    return this.vault.status();
  }
  vaultBackup(actor: Actor) {
    requireOperator(actor);
    return this.vault.backup();
  }
  async vaultRestore(actor: Actor, document: unknown, password: string) {
    requireOperator(actor);
    await this.vault.restore(document, password);
    for (const p of this.store.data.profiles) this.invalidation(p.id);
    this.store.audit(actor.id, "vault.restore", "completed");
    return this.vault.status();
  }
  async inspectHost(actor: Actor, targetId: string, signal?: AbortSignal) {
    requireOperator(actor);
    const profile = this.profile(targetId);
    const result = await this.pool.inspect(actor, profile, signal);
    return { targetId, revision: profile.revision, ...result };
  }
  confirmHost(
    actor: Actor,
    targetId: string,
    expectedRevision: number,
    key: string,
    expectedFingerprint: string,
  ) {
    requireOperator(actor);
    const profile = this.profile(targetId);
    if (profile.revision !== expectedRevision)
      fault("CONFLICT", "Target changed before trust confirmation.");
    if (Buffer.from(key, "base64").length > 16384)
      fault("INVALID_ARGUMENT", "Host key exceeds its size limit.");
    const check = requireFingerprint(Buffer.from(key, "base64"));
    if (check !== expectedFingerprint)
      fault("INVALID_ARGUMENT", "Host key and confirmation fingerprint do not match.");
    this.invalidation(targetId);
    this.store.change((d) => {
      d.pins = d.pins.filter((p) => p.profileId !== targetId);
      d.pins.push({
        profileId: targetId,
        revision: profile.revision,
        fingerprint: check,
        key,
        revoked: false,
      });
    });
    this.store.audit(actor.id, "trust.confirm", "completed", targetId);
    return { targetId, fingerprint: check };
  }
  revokeHost(actor: Actor, targetId: string) {
    requireOperator(actor);
    this.profile(targetId);
    this.invalidation(targetId);
    this.store.change((d) => {
      for (const pin of d.pins.filter((p) => p.profileId === targetId)) pin.revoked = true;
    });
    this.store.audit(actor.id, "trust.revoke", "completed", targetId);
    return { completed: true };
  }
  async openConnection(actor: Actor, targetId: string, signal?: AbortSignal) {
    const lease = await this.pool.acquire(actor, targetId, "connect", signal);
    lease.release();
    const info = { ...lease.info };
    this.store.audit(actor.id, "connection.open", "completed", targetId);
    return info;
  }
  connections(actor: Actor) {
    return this.pool.list(actor);
  }
  closeConnection(actor: Actor, connectionId: string) {
    this.pool.close(actor, connectionId);
    this.store.audit(actor.id, "connection.close", "completed");
    return { completed: true };
  }
  async reconnect(actor: Actor, targetId: string, signal?: AbortSignal) {
    this.authorize(actor, targetId, "connect");
    this.pool.invalidate(new Set([targetId]));
    return this.openConnection(actor, targetId, signal);
  }
  audit(_actor: Actor, cursor = 0) {
    const data = this.store.data;
    return {
      events: data.audit.filter((e) => e.sequence > cursor),
      cursor: data.auditSequence,
      gap: cursor < (data.audit[0]?.sequence ?? data.auditSequence + 1) - 1,
    };
  }
  diagnose(actor: Actor, targetId: string) {
    const p = this.profile(targetId);
    return {
      targetId,
      revision: p.revision,
      grants: this.grants(actor, targetId),
      vault: this.vault.status(),
      connections: this.connections(actor).filter((c) => c.targetId === targetId),
      features: { tmux: p.shell === "posix", shell: p.shell, routeHops: p.jumpIds.length },
      limits: this.pool.limits,
    };
  }
  detachActor(actorId: string) {
    this.sessionService.detachActor(actorId);
  }
  shutdown() {
    if (this.closed) return;
    this.sessionService.shutdown();
    this.jobService.shutdown();
    this.tunnelService.shutdown();
    this.pool.shutdown();
    this.vault.close();
    this.closed = true;
    this.store.close();
    this.releaseOwner();
  }
}
import { fingerprint as requireFingerprint } from "./trust.js";
