import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { SSHManager } from "../dist/index.js";
import { runApprovedCommand } from "../examples/embedded.mjs";
import {
  sshFixture,
  managedFixture,
  profileInput,
  operator,
  agent,
  vaultPassword,
  allCapabilities,
  until,
  delay,
} from "./fixture.mjs";

test("unknown, changed and revoked keys fail closed without editing known_hosts", async (t) => {
  const ctx = await managedFixture(t);
  const { fixture } = ctx;
  const different = await sshFixture();
  t.after(different.close);
  const profile = ctx.manager.createProfile(operator, {
    ...profileInput(ctx.profile),
    name: "unknown",
  });
  ctx.manager.setGrants(operator, profile.id, 1, allCapabilities);
  await assert.rejects(ctx.manager.openConnection(agent, profile.id), { code: "HOST_KEY_UNKNOWN" });
  const inspected = await ctx.manager.inspectHost(operator, profile.id);
  assert.equal(inspected.fingerprint, fixture.fingerprint);
  ctx.manager.confirmHost(
    operator,
    profile.id,
    1,
    different.publicKey.toString("base64"),
    different.fingerprint,
  );
  ctx.manager.setGrants(operator, profile.id, 1, allCapabilities);
  await assert.rejects(ctx.manager.openConnection(agent, profile.id), { code: "HOST_KEY_CHANGED" });
  ctx.manager.revokeHost(operator, ctx.profile.id);
  ctx.manager.setGrants(operator, ctx.profile.id, 1, allCapabilities);
  await assert.rejects(ctx.manager.openConnection(agent, ctx.profile.id), {
    code: "HOST_KEY_REVOKED",
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "known-host-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const knownHosts = path.join(directory, "known_hosts");
  const line = `[127.0.0.1]:${fixture.port} ssh-rsa ${fixture.publicKey.toString("base64")}\n`;
  fs.writeFileSync(knownHosts, line + "@revoked " + line);
  const before = fs.readFileSync(knownHosts);
  const state = path.join(directory, "state");
  const manager = new SSHManager({ stateDirectory: state, knownHosts: [knownHosts] });
  t.after(() => manager.shutdown());
  await manager.vaultInitialize(operator, vaultPassword);
  const cred = manager.addCredential(
    operator,
    { kind: "vault", name: "test", secretKind: "password" },
    { value: "ephemeral-test-password" },
  );
  const host = manager.createProfile(operator, {
    name: "revoked",
    host: "127.0.0.1",
    port: fixture.port,
    username: "fixture",
    credentialId: cred.id,
  });
  manager.setGrants(operator, host.id, 1, allCapabilities);
  await assert.rejects(manager.openConnection(agent, host.id), { code: "HOST_KEY_REVOKED" });
  assert.deepEqual(fs.readFileSync(knownHosts), before);
  fs.writeFileSync(knownHosts, line);
  await manager.openConnection(agent, host.id);
  fs.writeFileSync(knownHosts, "@revoked " + line);
  await until(() => manager.connections(agent).length === 0);
  await assert.rejects(manager.openConnection(agent, host.id), { code: "HOST_KEY_REVOKED" });
});
test("plain PTYs are lost after restart; tmux fault fixture restores only an existing remote session", async (t) => {
  const ctx = await managedFixture(t, { ssh: { tmux: true } });
  const { fixture } = ctx;
  let manager = ctx.manager;
  const plain = await manager.sessions.create(agent, ctx.profile.id);
  const persistent = await manager.sessions.create(agent, ctx.profile.id, { tmux: true });
  await manager.sessions.attach(agent, persistent.id);
  manager.sessions.writer(agent, persistent.id);
  manager.sessions.input(agent, persistent.id, "preserved\r");
  await until(() =>
    manager.sessions
      .read(agent, persistent.id)
      .output.parts.some((p) => p.text.includes("preserved")),
  );
  manager.detachActor(agent.id);
  assert.equal(manager.sessions.read(agent, plain.id).session.state, "running");
  const connection = manager.connections(agent)[0];
  manager.closeConnection(agent, connection.id);
  await until(() => manager.sessions.read(agent, plain.id).session.state === "lost");
  assert.equal(manager.sessions.read(agent, persistent.id).session.state, "recoverable");
  await manager.sessions.recover(agent, persistent.id);
  manager = ctx.restart();
  assert.equal(manager.sessions.read(agent, plain.id).session.state, "lost");
  assert.equal(manager.sessions.read(agent, persistent.id).session.state, "recoverable");
  await assert.rejects(manager.sessions.recover(agent, persistent.id), { code: "VAULT_LOCKED" });
  await manager.vaultUnlock(operator, vaultPassword);
  await manager.sessions.recover(agent, persistent.id);
  await until(() =>
    manager.sessions
      .read(agent, persistent.id)
      .output.parts.some((p) => p.text.includes("preserved")),
  );
  manager.closeConnection(agent, manager.connections(agent)[0].id);
  fixture.tmux.clear();
  await assert.rejects(manager.sessions.recover(agent, persistent.id), {
    code: "TMUX_UNAVAILABLE",
  });
  assert.equal(manager.sessions.read(agent, persistent.id).session.state, "recoverable");
});
test("pool wait cancellation, group partial errors, recordings and independent embedding", async (t) => {
  const ctx = await managedFixture(t, {
    limits: { connections: 1, perTarget: 1, channels: 1, waiters: 1, outputBytes: 4096 },
  });
  const { manager, profile } = ctx;
  const terminal = await manager.sessions.create(agent, profile.id, { recording: true });
  await assert.rejects(manager.inspectHost(operator, profile.id), { code: "LIMIT" });
  await until(() => manager.sessions.read(agent, terminal.id).output.parts.length);
  const recording = manager.sessions.recording(agent, terminal.id);
  assert.ok(recording.text.includes("fixture"));
  assert.ok(
    !fs.readFileSync(path.join(ctx.directory, "vault.json"), "utf8").includes("fixture ready"),
  );
  const controller = new AbortController();
  const wait = manager.jobs.start(agent, profile.id, "queued", { signal: controller.signal });
  await delay(30);
  controller.abort();
  await assert.rejects(wait, { code: "CANCELLED" });
  manager.sessions.close(agent, terminal.id);
  const unauthorized = manager.createProfile(agent, {
    name: "denied",
    host: "127.0.0.1",
    username: "fixture",
  });
  const group = await manager.jobs.group(agent, [profile.id, unauthorized.id], "group-test");
  assert.ok(group[0].job);
  assert.equal(group[1].error.code, "FORBIDDEN");
  await until(() => manager.jobs.read(agent, group[0].job.id).job.state !== "running");
  const large = await manager.jobs.start(agent, profile.id, "large");
  await until(() => manager.jobs.read(agent, large.id).job.state !== "running");
  assert.ok(manager.jobs.read(agent, large.id).output.gap);
  const total = manager.jobs
    .read(agent, large.id)
    .output.parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
  assert.ok(total <= 4096);
  manager.shutdown();
  const embedded = await runApprovedCommand({
    stateDirectory: ctx.directory,
    targetId: profile.id,
    command: "embedded",
    actor: agent,
    setup: (m) => m.vaultUnlock(operator, vaultPassword),
  });
  assert.equal(embedded.job.exitCode, 0);
});
test("inspection budgets count pending and established connections independently", async (t) => {
  for (const [name, limits] of [
    ["total transports", { connections: 1, perTarget: 2 }],
    ["per target", { connections: 2, perTarget: 1 }],
  ]) {
    await t.test(name, async (t) => {
      const { manager, profile, fixture } = await managedFixture(t, {
        limits,
        ssh: { authDelay: 250 },
      });
      const opening = manager.openConnection(agent, profile.id);
      await until(() => fixture.counts.auth > 0);
      assert.deepEqual(manager.connections(agent), []);
      await assert.rejects(manager.inspectHost(operator, profile.id), { code: "LIMIT" });
      const connection = await opening;
      await assert.rejects(manager.inspectHost(operator, profile.id), { code: "LIMIT" });
      assert.equal((await manager.openConnection(agent, profile.id)).id, connection.id);
      manager.closeConnection(agent, connection.id);
      assert.equal(
        (await manager.inspectHost(operator, profile.id)).fingerprint,
        fixture.fingerprint,
      );
    });
  }
});
test("pool eviction respects the total budget and saturated jump dependencies", async (t) => {
  for (const [name, limits] of [
    ["total transports", { connections: 2, perTarget: 2 }],
    ["per target", { connections: 4, perTarget: 1 }],
  ]) {
    await t.test(name, async (t) => {
      const { manager, profile, fixture } = await managedFixture(t, { limits });
      const profiles = [[], [profile.id]].map((jumpIds, index) => {
        const target = manager.createProfile(operator, {
          ...profileInput(profile),
          name: `eviction-${index}`,
          jumpIds,
        });
        manager.confirmHost(
          operator,
          target.id,
          1,
          fixture.publicKey.toString("base64"),
          fixture.fingerprint,
        );
        manager.setGrants(operator, target.id, 1, allCapabilities);
        return target;
      });
      const [unrelated, routed] = profiles;
      await manager.openConnection(agent, unrelated.id);
      await manager.openConnection(agent, profile.id);
      const connection = await manager.openConnection(agent, routed.id);
      assert.deepEqual(
        manager.connections(agent).map((item) => item.targetId),
        limits.perTarget === 1 ? [unrelated.id, routed.id] : [routed.id],
      );
      assert.equal((await manager.openConnection(agent, routed.id)).id, connection.id);
    });
  }
});
test("flat jump chains and both configured proxy protocols authenticate through verified hops", async (t) => {
  const ctx = await managedFixture(t);
  const first = ctx.fixture;
  const final = await sshFixture();
  t.after(final.close);
  const proxies = [];
  t.after(async () => {
    for (const p of proxies) await p.close();
  });
  const target = ctx.manager.createProfile(operator, {
    ...profileInput(ctx.profile),
    name: "via-jump",
    port: final.port,
    jumpIds: [ctx.profile.id],
  });
  ctx.manager.confirmHost(
    operator,
    target.id,
    1,
    final.publicKey.toString("base64"),
    final.fingerprint,
  );
  ctx.manager.setGrants(operator, target.id, 1, allCapabilities);
  await ctx.manager.openConnection(agent, target.id);
  assert.ok(first.counts.auth > 0 && final.counts.auth > 0);
  for (const kind of ["http-connect", "socks5"]) {
    const proxy = await proxyFixture(kind);
    proxies.push(proxy);
    const profile = ctx.manager.createProfile(operator, {
      ...profileInput(ctx.profile),
      name: kind,
      port: final.port,
      proxy: { kind, host: "127.0.0.1", port: proxy.port },
    });
    ctx.manager.confirmHost(
      operator,
      profile.id,
      1,
      final.publicKey.toString("base64"),
      final.fingerprint,
    );
    ctx.manager.setGrants(operator, profile.id, 1, allCapabilities);
    const job = await ctx.manager.jobs.start(agent, profile.id, kind);
    await until(() => ctx.manager.jobs.read(agent, job.id).job.state !== "running");
    assert.equal(ctx.manager.jobs.read(agent, job.id).job.exitCode, 0);
  }
  const additional = Array.from({ length: 3 }, (_, index) => {
    const jump = ctx.manager.createProfile(operator, {
      ...profileInput(ctx.profile),
      name: `jump-${index}`,
    });
    ctx.manager.confirmHost(
      operator,
      jump.id,
      1,
      first.publicKey.toString("base64"),
      first.fingerprint,
    );
    ctx.manager.setGrants(operator, jump.id, 1, allCapabilities);
    return jump.id;
  });
  const four = ctx.manager.createProfile(operator, {
    ...profileInput(ctx.profile),
    name: "four-jumps",
    port: final.port,
    jumpIds: [ctx.profile.id, ...additional],
  });
  ctx.manager.confirmHost(
    operator,
    four.id,
    1,
    final.publicKey.toString("base64"),
    final.fingerprint,
  );
  ctx.manager.setGrants(operator, four.id, 1, allCapabilities);
  await ctx.manager.openConnection(agent, four.id);
  assert.throws(
    () =>
      ctx.manager.createProfile(operator, {
        ...profileInput(ctx.profile),
        jumpIds: [ctx.profile.id, ...additional, target.id],
      }),
    { code: "INVALID_ARGUMENT" },
  );
  const loop = ctx.manager.createProfile(operator, {
    ...profileInput(ctx.profile),
    name: "loop",
    jumpIds: [ctx.profile.id, ctx.profile.id],
  });
  ctx.manager.setGrants(operator, loop.id, 1, allCapabilities);
  await assert.rejects(ctx.manager.openConnection(agent, loop.id), { code: "INVALID_ROUTE" });
  ctx.manager.revokeHost(operator, ctx.profile.id);
  await assert.rejects(ctx.manager.openConnection(agent, target.id), { code: "FORBIDDEN" });
});
async function proxyFixture(kind) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let state = 0,
      buffer = Buffer.alloc(0);
    const consume = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (kind === "http-connect") {
        if (!buffer.includes("\r\n\r\n")) return;
        const line = buffer.toString().split("\r\n")[0];
        const match = line.match(/^CONNECT ([^:]+):(\d+) HTTP\/1.1$/);
        if (!match) return socket.destroy();
        socket.off("data", consume);
        link(
          match[1],
          Number(match[2]),
          Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n"),
        );
      } else if (state === 0 && buffer.length >= 3) {
        buffer = buffer.subarray(3);
        state = 1;
        socket.write(Buffer.from([5, 0]));
      } else if (state === 1 && buffer.length >= 5) {
        const type = buffer[3],
          length = type === 1 ? 4 : buffer[4];
        const offset = type === 1 ? 4 : 5;
        if (buffer.length < offset + length + 2) return;
        const host =
          type === 1
            ? [...buffer.subarray(offset, offset + length)].join(".")
            : buffer.subarray(offset, offset + length).toString();
        const port = buffer.readUInt16BE(offset + length);
        socket.off("data", consume);
        link(host, port, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      }
    };
    function link(host, port, reply) {
      const destination = net.connect(port, host);
      sockets.add(destination);
      destination.on("error", () => socket.destroy());
      destination.once("close", () => {
        sockets.delete(destination);
        socket.destroy();
      });
      socket.once("close", () => destination.destroy());
      destination.once("connect", () => {
        socket.write(reply);
        socket.pipe(destination).pipe(socket);
      });
    }
    socket.on("data", consume);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
