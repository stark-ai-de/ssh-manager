import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { Vault } from "../dist/vault.js";
import { knownHostMatches } from "../dist/trust.js";
import { OutputBuffer } from "../dist/util.js";
import { proxySocket } from "../dist/proxy.js";
import {
  managedFixture,
  profileInput,
  operator,
  agent,
  second,
  allCapabilities,
  password,
  vaultPassword,
  until,
  delay,
} from "./fixture.mjs";

test("vault rejects wrong passwords, record swapping and tampering; rewrap and restore preserve ciphertext", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vault-fixture-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const vault = new Vault(directory);
  await vault.initialize(vaultPassword);
  vault.put("one", { value: "ephemeral-secret-one" });
  vault.put("two", { value: "ephemeral-secret-two" });
  const backup = vault.backup();
  assert.ok(!JSON.stringify(backup).includes("ephemeral-secret"));
  vault.lock();
  await assert.rejects(vault.unlock("incorrect-test-password"), { code: "VAULT_AUTHENTICATION" });
  await vault.unlock(vaultPassword);
  await vault.rotate(vaultPassword, "replacement-test-password");
  assert.deepEqual(vault.backup().records, backup.records);
  vault.lock();
  await assert.rejects(vault.unlock(vaultPassword), { code: "VAULT_AUTHENTICATION" });
  await vault.unlock("replacement-test-password");
  assert.equal(vault.get("one").value, "ephemeral-secret-one");
  const swapped = structuredClone(backup);
  swapped.records.one = swapped.records.two;
  await assert.rejects(vault.restore(swapped, vaultPassword), { code: "VAULT_AUTHENTICATION" });
  assert.equal(vault.get("one").value, "ephemeral-secret-one");
  const tampered = structuredClone(backup);
  tampered.records.one.ciphertext = Buffer.from("invalid").toString("base64");
  await assert.rejects(vault.restore(tampered, vaultPassword), { code: "VAULT_AUTHENTICATION" });
  await vault.restore(backup, vaultPassword);
  assert.ok(vault.status().locked);
  assert.ok(fs.existsSync(path.join(directory, "vault.before-restore.json")));
  await vault.unlock(vaultPassword);
  assert.equal(vault.get("two").value, "ephemeral-secret-two");
  vault.lock();
});
test("known_hosts patterns, hashed names and output cursors are bounded", () => {
  assert.ok(knownHostMatches("*.example.test,!blocked.example.test", "host.example.test"));
  assert.ok(!knownHostMatches("*.example.test,!blocked.example.test", "blocked.example.test"));
  const salt = Buffer.alloc(16, 1);
  const digest = createHmac("sha1", salt).update("[host.example.test]:2222").digest("base64");
  assert.ok(
    knownHostMatches(`|1|${salt.toString("base64")}|${digest}`, "[host.example.test]:2222"),
  );
  const buffer = new OutputBuffer(16);
  for (let i = 0; i < 10; i++) buffer.append(Buffer.from("test-data"));
  assert.ok(buffer.page().gap);
  assert.ok(buffer.page().parts.reduce((n, p) => n + Buffer.byteLength(p.text), 0) <= 16);
  assert.throws(() => buffer.page(100), { code: "INVALID_CURSOR" });
});
test("permissions, explicit trust, connection reuse and profile revisions apply to the direct library", async (t) => {
  const ctx = await managedFixture(t);
  const { fixture, manager, profile } = ctx;
  assert.throws(() => manager.setGrants(agent, profile.id, 1, allCapabilities), {
    code: "FORBIDDEN",
  });
  assert.throws(() => manager.confirmHost(agent, profile.id, 1, "x", "x"), { code: "FORBIDDEN" });
  assert.throws(() => manager.addCredential(agent, { kind: "agent", name: "test", socket: "x" }), {
    code: "FORBIDDEN",
  });
  assert.throws(
    () =>
      manager.createProfile(agent, {
        name: "stolen-ref",
        host: "127.0.0.1",
        username: "user",
        credentialId: ctx.credential.id,
      }),
    { code: "FORBIDDEN" },
  );
  const first = await manager.openConnection(agent, profile.id);
  const secondConnection = await manager.openConnection(agent, profile.id);
  assert.equal(first.id, secondConnection.id);
  const plain = manager.createProfile(agent, {
    name: "unapproved",
    host: "127.0.0.1",
    username: "user",
    port: fixture.port,
  });
  await assert.rejects(manager.openConnection(agent, plain.id), { code: "FORBIDDEN" });
  assert.throws(
    () =>
      manager.updateProfile(agent, profile.id, 1, {
        ...profileInput(profile),
        port: fixture.port + 1,
      }),
    { code: "FORBIDDEN" },
  );
  const changed = manager.updateProfile(operator, profile.id, 1, {
    ...profileInput(profile),
    username: "changed-user",
  });
  assert.equal(changed.revision, 2);
  assert.equal(manager.connections(agent).length, 0);
  await assert.rejects(manager.openConnection(agent, profile.id), { code: "FORBIDDEN" });
  assert.throws(() => manager.updateProfile(operator, profile.id, 1, profileInput(profile)), {
    code: "CONFLICT",
  });
  const diagnostic = JSON.stringify(manager.diagnose(agent, profile.id));
  assert.ok(!diagnostic.includes(password));
  assert.ok(!JSON.stringify(manager.audit(agent)).includes(password));
});
test("resource lists preserve order and snapshots while filtering targets and revoked authority", async (t) => {
  const { manager, profile, fixture } = await managedFixture(t);
  const other = manager.createProfile(operator, { ...profileInput(profile), name: "other target" });
  manager.confirmHost(
    operator,
    other.id,
    1,
    fixture.publicKey.toString("base64"),
    fixture.fingerprint,
  );
  manager.setGrants(operator, other.id, 1, allCapabilities);
  const listings = [
    [manager.sessions, (target) => manager.sessions.create(agent, target)],
    [manager.jobs, (target) => manager.jobs.start(agent, target, "hang")],
    [
      manager.tunnels,
      (target) => manager.tunnels.create(agent, target, { kind: "socks", listenPort: 0 }),
    ],
  ];
  const expected = [];
  for (const [service, create] of listings) {
    const resources = [];
    for (const target of [profile.id, other.id, profile.id]) resources.push(await create(target));
    const selected = [resources[0].id, resources[2].id];
    expected.push(selected);
    assert.deepEqual(
      service.list(agent).map((item) => item.id),
      resources.map((item) => item.id),
    );
    assert.deepEqual(
      service.list(agent, profile.id).map((item) => item.id),
      selected,
    );
    assert.deepEqual(service.list(agent, "missing-target"), []);
    service.list(agent)[0].state = "caller-owned-copy";
    assert.equal(service.list(agent)[0].state, resources[0].state);
  }
  const connections = manager.connections(agent);
  assert.deepEqual(
    connections.map((item) => item.targetId),
    [profile.id, other.id],
  );
  manager.connections(agent)[0].channels = -1;
  assert.equal(manager.connections(agent)[0].channels, connections[0].channels);
  manager.setGrants(operator, other.id, 1, ["connect"]);
  for (const [index, [service]] of listings.entries()) {
    assert.deepEqual(
      service.list(agent).map((item) => item.id),
      expected[index],
    );
    assert.deepEqual(service.list(agent, other.id), []);
  }
  manager.setGrants(operator, other.id, 1, []);
  await assert.rejects(manager.openConnection(operator, other.id), { code: "FORBIDDEN" });
  assert.deepEqual(
    manager.connections(agent).map((item) => item.targetId),
    [profile.id],
  );
  assert.deepEqual(
    manager.connections(operator).map((item) => item.targetId),
    [profile.id],
  );
  manager.shutdown();
  assert.deepEqual(manager.connections(agent), []);
  for (const [service] of listings) assert.deepEqual(service.list(agent), []);
});
test("jobs, readers, writer authority, detach and vault lock retain truthful lifecycles", async (t) => {
  const ctx = await managedFixture(t);
  const { fixture, manager, profile } = ctx;
  const job = await manager.jobs.start(agent, profile.id, "test-command");
  await until(() => manager.jobs.read(agent, job.id).job.state !== "running");
  assert.equal(manager.jobs.read(agent, job.id).job.exitCode, 0);
  assert.equal(fixture.counts.exec, 1);
  const failed = await manager.jobs.start(agent, profile.id, "fail");
  await until(() => manager.jobs.read(agent, failed.id).job.state !== "running");
  assert.equal(manager.jobs.read(agent, failed.id).job.state, "failed");
  const hung = await manager.jobs.start(agent, profile.id, "hang");
  assert.equal(manager.jobs.cancel(agent, hung.id).remoteTerminationConfirmed, false);
  const session = await manager.sessions.create(agent, profile.id);
  await until(() => manager.sessions.read(agent, session.id).output.parts.length);
  await manager.sessions.attach(agent, session.id);
  await manager.sessions.attach(second, session.id);
  manager.sessions.writer(agent, session.id);
  assert.throws(() => manager.sessions.writer(second, session.id, true), { code: "FORBIDDEN" });
  assert.throws(() => manager.sessions.input(second, session.id, "x"), { code: "WRITER_REQUIRED" });
  manager.sessions.input(agent, session.id, "next\r");
  await until(() =>
    manager.sessions.read(agent, session.id).output.parts.some((p) => p.text.includes("next")),
  );
  manager.sessions.detach(agent, session.id);
  assert.equal(manager.sessions.read(second, session.id).session.state, "running");
  manager.sessions.writer(second, session.id);
  manager.vaultLock(operator);
  manager.sessions.input(second, session.id, "still-connected\r");
  const reused = await manager.openConnection(agent, profile.id);
  manager.closeConnection(agent, reused.id);
  await until(() => manager.sessions.read(second, session.id).session.state === "lost");
  await assert.rejects(manager.openConnection(agent, profile.id), { code: "VAULT_LOCKED" });
  assert.equal(fixture.counts.exec, 3);
  assert.equal(manager.jobs.read(agent, job.id).job.state, "succeeded");
});
test("SFTP streaming, metadata, mutation and root containment", async (t) => {
  const ctx = await managedFixture(t);
  const { manager, profile } = ctx;
  assert.equal((await manager.files.list(agent, profile.id, "/allowed"))[0].name, "hello.txt");
  assert.equal(
    Buffer.from(
      (await manager.files.read(agent, profile.id, "/allowed/hello.txt")).data,
      "base64",
    ).toString(),
    "hello fixture\n",
  );
  await manager.files.upload(
    agent,
    profile.id,
    "/allowed/upload.bin",
    Readable.from(Buffer.alloc(200000, 7)),
  );
  assert.equal((await manager.files.stat(agent, profile.id, "/allowed/upload.bin")).size, 200000);
  await manager.files.mutate(agent, profile.id, "mkdir", "/allowed/new");
  await manager.files.mutate(agent, profile.id, "rename", "/allowed/upload.bin", {
    destination: "/allowed/new/moved.bin",
  });
  await manager.files.mutate(agent, profile.id, "chmod", "/allowed/new/moved.bin", { mode: 0o640 });
  await assert.rejects(manager.files.read(agent, profile.id, "/allowed/../escape"), {
    code: "PATH_DENIED",
  });
  await assert.rejects(manager.files.upload(agent, profile.id, "/outside", Readable.from("x")), {
    code: "PATH_DENIED",
  });
  await manager.files.mutate(agent, profile.id, "remove", "/allowed/new/moved.bin");
  await manager.files.mutate(agent, profile.id, "remove", "/allowed/new", { directory: true });
});
test("local, remote and SOCKS tunnels close their listeners; occupied ports fail without crashing", async (t) => {
  const ctx = await managedFixture(t);
  const echo = net.createServer((s) => s.pipe(s));
  t.after(() => new Promise((r) => echo.close(r)));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const destinationPort = echo.address().port;
  for (const kind of ["local", "remote", "socks"]) {
    const tunnel = await ctx.manager.tunnels.create(agent, ctx.profile.id, {
      kind,
      listenPort: 0,
      destinationHost: "127.0.0.1",
      destinationPort,
    });
    const socket =
      kind === "socks"
        ? await proxySocket(
            { kind: "socks5", host: "127.0.0.1", port: tunnel.listenPort },
            "127.0.0.1",
            destinationPort,
            1000,
          )
        : net.connect(tunnel.listenPort, "127.0.0.1");
    socket.on("error", () => {});
    const response = new Promise((r) => socket.once("data", (d) => r(d.toString())));
    socket.resume();
    socket.write("echo-data");
    assert.equal(await response, "echo-data");
    socket.destroy();
    await ctx.manager.tunnels.close(agent, tunnel.id);
    assert.equal(ctx.manager.tunnels.list(agent).find((t) => t.id === tunnel.id).state, "closed");
  }
  await assert.rejects(
    ctx.manager.tunnels.create(agent, ctx.profile.id, {
      kind: "local",
      listenPort: destinationPort,
      destinationHost: "127.0.0.1",
      destinationPort,
    }),
    { code: "PORT_UNAVAILABLE" },
  );
});
test("channel deadlines, concurrent profile invalidation and bounded pool waiters", async (t) => {
  const ctx = await managedFixture(t, {
    ssh: { hangShell: true, hangSftp: true },
    limits: { channelTimeout: 150 },
  });
  await assert.rejects(ctx.manager.sessions.create(agent, ctx.profile.id), { code: "TIMEOUT" });
  await assert.rejects(ctx.manager.files.list(agent, ctx.profile.id, "/allowed"), {
    code: "TIMEOUT",
  });
  const other = await managedFixture(t, { ssh: { authDelay: 120 } });
  const attempt = other.manager.openConnection(agent, other.profile.id);
  await delay(30);
  other.manager.updateProfile(operator, other.profile.id, 1, {
    ...profileInput(other.profile),
    username: "changed",
  });
  await assert.rejects(attempt);
  assert.equal(other.manager.connections(operator).length, 0);
});
