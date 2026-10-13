import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { Readable } from "node:stream";
import { managedFixture, agent, operator, delay, until } from "./fixture.mjs";

test("denied channels and vault locking during authentication release pending resources", async (t) => {
  const ctx = await managedFixture(t, { ssh: { denyChannels: true } });
  await assert.rejects(ctx.manager.jobs.start(agent, ctx.profile.id, "denied"), {
    code: "SSH_REQUEST_FAILED",
  });
  await assert.rejects(ctx.manager.sessions.create(agent, ctx.profile.id), {
    code: "SSH_REQUEST_FAILED",
  });
  await assert.rejects(ctx.manager.files.list(agent, ctx.profile.id, "/allowed"), {
    code: "SSH_REQUEST_FAILED",
  });
  assert.equal(ctx.manager.connections(agent)[0].channels, 0);
  const pending = await managedFixture(t, { ssh: { authDelay: 200 } });
  const connection = pending.manager.openConnection(agent, pending.profile.id);
  await delay(40);
  pending.manager.vaultLock(operator);
  await assert.rejects(connection, { code: "CANCELLED" });
  assert.equal(pending.manager.connections(agent).length, 0);
});
test("directory budgets, transfer cancellation and symlink containment hold on SFTP", async (t) => {
  const ctx = await managedFixture(t);
  const { fixture } = ctx;
  fs.mkdirSync(path.join(fixture.directory, "allowed", "many"));
  for (let i = 0; i < 4097; i++)
    fs.writeFileSync(path.join(fixture.directory, "allowed", "many", `file-${i}`), "");
  await assert.rejects(ctx.manager.files.list(agent, ctx.profile.id, "/allowed/many"), {
    code: "LIMIT",
  });
  const controller = new AbortController();
  const upload = ctx.manager.files.upload(
    agent,
    ctx.profile.id,
    "/allowed/partial",
    Readable.from(
      (async function* () {
        yield Buffer.alloc(8192);
        await delay(300);
        yield Buffer.alloc(8192);
      })(),
    ),
    { signal: controller.signal },
  );
  await delay(70);
  controller.abort();
  await assert.rejects(upload, { code: "CANCELLED" });
  await until(() => ctx.manager.connections(agent).every((c) => c.channels === 0));
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(fixture.directory, "outside"));
    fs.writeFileSync(path.join(fixture.directory, "outside", "secret"), "fixture-only");
    fs.symlinkSync("../outside", path.join(fixture.directory, "allowed", "escape"));
    await assert.rejects(ctx.manager.files.read(agent, ctx.profile.id, "/allowed/escape/secret"), {
      code: "PATH_DENIED",
    });
    await assert.rejects(
      ctx.manager.files.upload(agent, ctx.profile.id, "/allowed/escape/new", Readable.from("x")),
      { code: "PATH_DENIED" },
    );
    fs.symlinkSync("hello.txt", path.join(fixture.directory, "allowed", "inside"));
    await ctx.manager.files.mutate(agent, ctx.profile.id, "remove", "/allowed/inside");
    assert.ok(
      fs.existsSync(path.join(fixture.directory, "allowed", "hello.txt")),
      "unlink must remove the link, not its destination",
    );
  }
});
test("failed tunnel setup frees listener slots and forwarding streams obey connection channel limits", async (t) => {
  const ctx = await managedFixture(t, { limits: { tunnels: 1, channels: 2, perTarget: 1 } });
  const sockets = new Set();
  const echo = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => echo.close(r));
  });
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const input = {
    kind: "local",
    listenPort: echo.address().port,
    destinationHost: "127.0.0.1",
    destinationPort: echo.address().port,
  };
  await assert.rejects(ctx.manager.tunnels.create(agent, ctx.profile.id, input), {
    code: "PORT_UNAVAILABLE",
  });
  const tunnel = await ctx.manager.tunnels.create(agent, ctx.profile.id, {
    ...input,
    listenPort: 0,
  });
  const socket = net.connect(tunnel.listenPort, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await new Promise((r) => socket.once("connect", r));
  await until(() => ctx.manager.connections(agent)[0].channels === 2);
  const extra = net.connect(tunnel.listenPort, "127.0.0.1");
  extra.on("error", () => {});
  await new Promise((r) => extra.once("close", r));
  assert.equal(ctx.manager.connections(agent)[0].channels, 2);
  socket.destroy();
  await ctx.manager.tunnels.close(agent, tunnel.id);
});

test(
  "SFTP fixture preserves remote roots when the OS temporary root is a symlink",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-temp-alias-"));
    let ctx;
    t.after(async () => {
      try {
        await ctx?.close();
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });
    const actual = path.join(base, "actual"),
      alias = path.join(base, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, "dir");
    ctx = await managedFixture(t, { ssh: { temporaryRoot: alias } });
    const { fixture } = ctx;
    assert.equal(fixture.directory, fs.realpathSync(fixture.directory));
    const result = await ctx.manager.files.read(agent, ctx.profile.id, "/allowed/hello.txt");
    assert.equal(Buffer.from(result.data, "base64").toString(), "hello fixture\n");
  },
);
