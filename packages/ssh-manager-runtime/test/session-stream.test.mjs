import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { ManagementClient } from "../dist/client.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const registration = {
  data: {
    token: "t".repeat(43),
    actor: { id: "actual-actor", kind: "agent" },
    expiresInMs: 120000,
  },
};
const snapshot = {
  session: {
    id: "session-1",
    targetId: "target-1",
    state: "running",
    cols: 80,
    rows: 24,
    tmux: false,
    recording: false,
    createdAt: new Date().toISOString(),
  },
  snapshot: "",
  cursor: 0,
  output: { parts: [], cursor: 0, gap: false },
  recordingPaused: false,
};
async function fixture(t) {
  let upgrades = 0,
    peer;
  const sockets = new Set();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(req.url === "/v1/clients" ? registration : { data: { detached: true } }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgrades++;
    wss.handleUpgrade(req, socket, head, (value) => {
      peer = value;
      value.once("message", (raw) => {
        assert.deepEqual(JSON.parse(raw.toString()), {
          token: "t".repeat(43),
          sessionId: "session-1",
        });
        value.send(JSON.stringify({ type: "attached", data: snapshot }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new ManagementClient(
    `http://127.0.0.1:${server.address().port}/`,
    "b".repeat(43),
    { automaticHeartbeat: false, strictCleanup: true },
  );
  await client.connect();
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    client,
    get upgrades() {
      return upgrades;
    },
    get peer() {
      return peer;
    },
  };
}

test("session stream withholds upgrade until actual fresh socket proof and decodes bounded events", async (t) => {
  const f = await fixture(t),
    proof = deferred(),
    entered = deferred();
  const authority = {
    assertCurrent() {},
    async beforeSend(socket) {
      assert.equal(socket.remoteAddress, "127.0.0.1");
      entered.resolve();
      await proof.promise;
    },
    async afterResponse() {},
    invalidate() {},
  };
  const stream = f.client.watchSession("session-1", { authority });
  await entered.promise;
  assert.equal(f.upgrades, 0);
  proof.resolve();
  assert.deepEqual(await stream.ready, snapshot);
  assert.equal(f.upgrades, 1);
  const iterator = stream.events[Symbol.asyncIterator]();
  f.peer.send(
    JSON.stringify({ type: "session.output", id: "session-1", targetId: "target-1", sequence: 1 }),
  );
  assert.deepEqual((await iterator.next()).value, {
    type: "session.output",
    id: "session-1",
    targetId: "target-1",
    sequence: 1,
  });
  await stream.close();
  await iterator.return();
});

test("closing a session retains an outstanding actual native response check", async (t) => {
  const f = await fixture(t),
    held = deferred(),
    entered = deferred();
  const stream = f.client.watchSession("session-1", {
    authority: {
      assertCurrent() {},
      async beforeSend() {},
      async afterResponse() {
        entered.resolve();
        await held.promise;
      },
      invalidate() {},
    },
  });
  await entered.promise;
  let done = false;
  const closing = stream.close().then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  held.resolve();
  await closing;
  await assert.rejects(stream.ready);
});

test("session rejects foreign events and bounds queued messages without a consumer", async (t) => {
  const f = await fixture(t);
  let invalidations = 0;
  const authority = {
    assertCurrent() {},
    async beforeSend() {},
    async afterResponse() {},
    invalidate() {
      invalidations++;
    },
  };
  const stream = f.client.watchSession("session-1", { authority, queuedMessages: 2 });
  await stream.ready;
  f.peer.send(
    JSON.stringify({ type: "session.output", id: "foreign-session", targetId: "target-1" }),
  );
  await stream.settled;
  assert.equal(invalidations, 1);
  const second = f.client.watchSession("session-1", { authority, queuedMessages: 2 });
  await second.ready;
  for (let i = 0; i < 3; i++)
    f.peer.send(
      JSON.stringify({
        type: "session.output",
        id: "session-1",
        targetId: "target-1",
        sequence: i,
      }),
    );
  await second.settled;
  assert.equal(invalidations, 2);
});

test("session pins target identity and sanitizes malformed remote frames", async (t) => {
  const f = await fixture(t);
  const authority = {
    assertCurrent() {},
    async beforeSend() {},
    async afterResponse() {},
    invalidate() {},
  };
  const stream = f.client.watchSession("session-1", { authority });
  await stream.ready;
  const iterator = stream.events[Symbol.asyncIterator]();
  const next = iterator.next();
  const rejected = assert.rejects(
    next,
    (error) => error.code === "API_RESPONSE" && !error.message.includes("target-foreign"),
  );
  f.peer.send(
    JSON.stringify({
      type: "session.output",
      id: "session-1",
      targetId: "target-foreign",
      sequence: 1,
    }),
  );
  await rejected;
  await stream.settled;
  const second = f.client.watchSession("session-1", { authority });
  await second.ready;
  const secondIterator = second.events[Symbol.asyncIterator]();
  const invalid = assert.rejects(
    secondIterator.next(),
    (error) => error.code === "API_RESPONSE" && !error.message.includes("private-host"),
  );
  f.peer.send("private-host.example");
  await invalid;
  await second.settled;
});

test("iterator return interrupts a waiting next and joins actual stream settlement", async (t) => {
  const f = await fixture(t);
  const stream = f.client.watchSession("session-1", {
    authority: {
      assertCurrent() {},
      async beforeSend() {},
      async afterResponse() {},
      invalidate() {},
    },
  });
  await stream.ready;
  const iterator = stream.events[Symbol.asyncIterator]();
  const waiting = iterator.next();
  const remoteClosed = once(f.peer, "close");
  await tick();
  await iterator.return();
  assert.equal((await waiting).done, true);
  await stream.settled;
  // Local settlement does not attest when the remote peer observes closure.
  await remoteClosed;
  assert.notEqual(f.peer.readyState, 1);
});
