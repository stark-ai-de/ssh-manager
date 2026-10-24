import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import ssh2 from "ssh2";
import { managedFixture, agent, operator, until, delay } from "./fixture.mjs";

const listen = (server, port = 0) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

test("a local tunnel reserves its chosen listener before SSH authentication", async (t) => {
  const ctx = await managedFixture(t, { ssh: { authDelay: 350 } });
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  let destinationConnections = 0;
  const destination = net.createServer((socket) => {
    destinationConnections++;
    socket.pipe(socket);
  });
  const destinationPort = await listen(destination);
  t.after(() => close(destination));
  const pending = ctx.manager.tunnels.create(agent, ctx.profile.id, {
    kind: "local",
    listenPort: port,
    destinationHost: "127.0.0.1",
    destinationPort,
    reconnect: false,
  });
  pending.catch(() => {});
  t.after(() => pending.catch(() => {}));
  await until(() => ctx.fixture.counts.auth > 0);
  const contender = net.createServer();
  try {
    await assert.rejects(listen(contender, port), { code: "EADDRINUSE" });
  } finally {
    await close(contender);
  }
  const early = net.connect(port, "127.0.0.1");
  early.on("error", () => {});
  t.after(() => early.destroy());
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Pending listener did not close its client")),
      1000,
    );
    early.once("close", () => {
      clearTimeout(deadline);
      resolve();
    });
    early.write("must not forward during authentication");
  });
  assert.equal(destinationConnections, 0);
  const tunnel = await pending;
  assert.equal(tunnel.listenPort, port);
  assert.equal(tunnel.state, "running");
  const socket = net.connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  const echoed = new Promise((resolve, reject) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.once("error", reject);
  });
  socket.write("reserved listener proof");
  assert.equal(await echoed, "reserved listener proof");
  assert.equal(destinationConnections, 1);
  socket.destroy();
  await ctx.manager.tunnels.close(agent, tunnel.id);
});

for (const action of ["abort", "close", "revoke", "shutdown"]) {
  test(`${action} during tunnel authentication releases only its reserved listener`, async (t) => {
    const ctx = await managedFixture(t, { ssh: { authDelay: 350 } });
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    const controller = new AbortController();
    const pending = ctx.manager.tunnels.create(
      agent,
      ctx.profile.id,
      {
        kind: "local",
        listenPort: port,
        destinationHost: "127.0.0.1",
        destinationPort: ctx.fixture.port,
        reconnect: false,
      },
      controller.signal,
    );
    const rejected = assert.rejects(pending, { code: "CANCELLED" });
    await until(() => ctx.fixture.counts.auth > 0);
    const resource = ctx.manager.tunnels.list(agent).find((value) => value.listenPort === port);
    assert.ok(resource);
    assert.equal(resource.state, "interrupted");
    if (action === "abort") controller.abort();
    else if (action === "revoke")
      ctx.manager.setGrants(operator, ctx.profile.id, ctx.profile.revision, []);
    else if (action === "shutdown") ctx.manager.shutdown();
    else {
      const closing = ctx.manager.tunnels.close(agent, resource.id);
      await assert.rejects(ctx.manager.tunnels.reconnect(agent, resource.id), { code: "CONFLICT" });
      assert.equal((await closing).state, "closed");
    }
    await rejected;
    const replacement = net.createServer();
    await listen(replacement, port);
    try {
      if (action !== "shutdown" && action !== "revoke") {
        assert.equal(
          ctx.manager.tunnels.list(agent).find((value) => value.id === resource.id).state,
          action === "close" ? "closed" : "failed",
        );
        await assert.rejects(ctx.manager.tunnels.reconnect(agent, resource.id), {
          code: "PORT_UNAVAILABLE",
        });
        assert.equal(
          replacement.listening,
          true,
          "A later failed reconnect must preserve the competing listener",
        );
      }
    } finally {
      await close(replacement);
    }
  });
}

test("close during an automatic reconnect cannot reschedule the closed tunnel", async (t) => {
  const ctx = await managedFixture(t, { ssh: { authDelay: 350 } });
  const tunnel = await ctx.manager.tunnels.create(agent, ctx.profile.id, {
    kind: "local",
    listenPort: 0,
    destinationHost: "127.0.0.1",
    destinationPort: ctx.fixture.port,
    reconnect: true,
  });
  const authenticated = ctx.fixture.counts.auth;
  for (const client of ctx.fixture.connections) client.end();
  await until(() => ctx.fixture.counts.auth > authenticated);
  const states = [];
  ctx.manager.on("event", (event) => {
    if (event.type === "tunnel.state" && event.id === tunnel.id)
      states.push(ctx.manager.tunnels.list(agent).find((value) => value.id === tunnel.id).state);
  });
  assert.equal((await ctx.manager.tunnels.close(agent, tunnel.id)).state, "closed");
  const replacement = net.createServer();
  await listen(replacement, tunnel.listenPort);
  try {
    const count = ctx.fixture.counts.auth;
    await delay(2200);
    assert.equal(
      ctx.manager.tunnels.list(agent).find((value) => value.id === tunnel.id).state,
      "closed",
    );
    assert.deepEqual(states, ["closed"]);
    assert.equal(ctx.fixture.counts.auth, count);
    assert.equal(replacement.listening, true);
  } finally {
    await close(replacement);
  }
});

test("abort after a real remote bind callback closes the successful late forwarding", async (t) => {
  const ctx = await managedFixture(t);
  const controller = new AbortController();
  let boundPort;
  const original = ssh2.Client.prototype.forwardIn;
  // Keep the real SSH request and server result. Only place cancellation at the
  // public ssh2 callback boundary, before the manager's awaiting continuation.
  t.mock.method(ssh2.Client.prototype, "forwardIn", function (host, port, callback) {
    return original.call(this, host, port, (error, assigned) => {
      if (!error) boundPort = assigned;
      callback(error, assigned);
      if (!error) controller.abort();
    });
  });
  await assert.rejects(
    ctx.manager.tunnels.create(
      agent,
      ctx.profile.id,
      {
        kind: "remote",
        listenPort: 0,
        destinationHost: "127.0.0.1",
        destinationPort: ctx.fixture.port,
        reconnect: false,
      },
      controller.signal,
    ),
    { code: "CANCELLED" },
  );
  assert.ok(
    Number.isSafeInteger(boundPort) && boundPort > 0,
    "The real remote listener must have bound successfully",
  );
  await until(() => [...ctx.fixture.forwards].every((server) => !server.listening));
  const replacement = net.createServer();
  await listen(replacement, boundPort);
  await close(replacement);
  assert.equal(ctx.manager.tunnels.list(agent)[0].state, "failed");
});
