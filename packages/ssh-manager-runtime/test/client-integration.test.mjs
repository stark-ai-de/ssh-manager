import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
  ManagementClient,
  createClientTransport,
  serializeClientJson,
  clientJsonBytes,
  isClientExchangeForTransport,
} from "../dist/client.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function peer(t, handler, { keepAliveTimeout } = {}) {
  const sockets = new Set();
  const server = createServer(handler);
  if (keepAliveTimeout !== undefined) server.keepAliveTimeout = keepAliveTimeout;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/`;
}
function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const registration = {
  data: {
    token: "t".repeat(43),
    actor: { id: "registered-actor", kind: "agent" },
    expiresInMs: 120000,
  },
};
const input = (url, signal, authority) => ({
  url,
  path: "/v1/clients",
  token: "b".repeat(43),
  method: "POST",
  body: "{}",
  requestBytes: 1048576,
  responseBytes: 16384,
  signal,
  authority,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("bounded JSON counts escapes and multibyte data before serialization", () => {
  for (const value of [
    { text: "é😀\n\t\\", unused: undefined },
    [null, true, 1, "\ud800"],
    { nested: [{ a: "x" }] },
  ]) {
    const expected = JSON.stringify(value);
    const bytes = Buffer.byteLength(expected);
    assert.equal(clientJsonBytes(value, bytes), bytes);
    assert.equal(serializeClientJson(value, bytes), expected);
    assert.throws(
      () => serializeClientJson(value, bytes - 1),
      (error) => error.code === "LIMIT",
    );
  }
  let reads = 0;
  assert.throws(() =>
    serializeClientJson(
      {
        get data() {
          reads++;
          return "secret";
        },
      },
      1024,
    ),
  );
  assert.equal(reads, 0);
});

test("cancelled caller keeps the actual socket/proof tail until proof finishes", async (t) => {
  let requests = 0;
  const url = await peer(t, (_req, res) => {
    requests++;
    json(res, registration);
  });
  const proof = deferred();
  const entered = deferred();
  const abort = new AbortController();
  const exchange = createClientTransport().start(
    input(url, abort.signal, {
      assertCurrent() {},
      async beforeSend(socket) {
        assert.equal(socket.remoteAddress, "127.0.0.1");
        entered.resolve();
        await proof.promise;
      },
      async afterResponse() {},
      invalidate() {},
    }),
  );
  const rejection = assert.rejects(
    exchange.result,
    (error) => error.code === "CANCELLED_OR_TIMEOUT",
  );
  await entered.promise;
  abort.abort();
  await rejection;
  let settled = false;
  exchange.settled.then(() => (settled = true));
  await tick();
  assert.equal(settled, false);
  assert.equal(requests, 0);
  proof.resolve();
  await exchange.settled;
  assert.equal(settled, true);
});

test("post-response cancellation revokes once and joins delayed validation", async (t) => {
  const url = await peer(t, (_req, res) => json(res, registration));
  const held = deferred();
  const entered = deferred();
  const abort = new AbortController();
  let revocations = 0;
  const exchange = createClientTransport().start(
    input(url, abort.signal, {
      assertCurrent() {},
      async beforeSend() {},
      async afterResponse() {
        entered.resolve();
        await held.promise;
      },
      invalidate() {
        revocations++;
      },
    }),
  );
  const rejection = assert.rejects(
    exchange.result,
    (error) => error.code === "CANCELLED_OR_TIMEOUT" && error.sent,
  );
  await entered.promise;
  abort.abort();
  await rejection;
  let settled = false;
  exchange.settled.then(() => (settled = true));
  await tick();
  assert.equal(settled, false);
  held.resolve();
  await exchange.settled;
  assert.equal(revocations, 1);
});

test("chunked error and malformed UTF-8 are rejected before unbounded parsing", async (t) => {
  let mode = "large";
  const url = await peer(t, (_req, res) => {
    res.writeHead(mode === "large" ? 403 : 200, { "content-type": "application/json" });
    res.write(mode === "large" ? "x".repeat(17000) : Buffer.from([0xff]));
    res.end();
  });
  for (const expected of ["LIMIT", "API_RESPONSE"]) {
    const exchange = createClientTransport().start(input(url, new AbortController().signal));
    await assert.rejects(exchange.result, (error) => error.code === expected && error.sent);
    await exchange.settled;
    mode = "utf8";
  }
});

test("real registration is private and close joins then sends one detach", async (t) => {
  const paths = [];
  const url = await peer(t, (req, res) => {
    paths.push(req.url);
    json(res, req.url === "/v1/clients" ? registration : { data: { detached: true } });
  });
  let invalidations = 0;
  let observed;
  const client = new ManagementClient(url, "b".repeat(43), {
    automaticHeartbeat: false,
    expectedKind: "agent",
    strictCleanup: true,
    strictLifecycle: true,
    authority: () => ({
      assertCurrent() {},
      async beforeSend() {},
      async afterResponse() {},
      invalidate() {
        invalidations++;
      },
    }),
    onRegistered(identity) {
      observed = identity;
    },
  });
  await client.connect();
  assert.equal(observed.id, "registered-actor");
  assert.equal(Object.isFrozen(observed), true);
  assert.equal("token" in observed, false);
  const close = client.close();
  assert.equal(client.close(), close);
  await close;
  assert.deepEqual(paths, ["/v1/clients", "/v1/clients/detach"]);
  assert.equal(invalidations, 0);
  await assert.rejects(client.connect(), (error) => error.code === "NOT_CONNECTED");
});

test("wrong actor kind never becomes registration authority", async (t) => {
  const url = await peer(t, (_req, res) =>
    json(res, { data: { ...registration.data, actor: { id: "wrong-actor", kind: "operator" } } }),
  );
  const client = new ManagementClient(url, "b".repeat(43), {
    automaticHeartbeat: false,
    expectedKind: "agent",
    strictLifecycle: true,
  });
  await assert.rejects(client.connect(), (error) => error.code === "API_RESPONSE");
  assert.equal(client.registration, undefined);
  await client.close();
});

test("legacy explicit reconnect creates a new actual registration", async (t) => {
  let registrations = 0;
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") registrations++;
    json(res, req.url === "/v1/clients" ? registration : { data: { detached: true } });
  });
  const client = new ManagementClient(url, "b".repeat(43), { automaticHeartbeat: false });
  await client.connect();
  await client.close();
  await client.connect();
  await client.close();
  assert.equal(registrations, 2);
});

test("exchange enrollment precedes JSON traversal and cannot be copied", async (t) => {
  const url = await peer(t, (_req, res) => json(res, registration));
  const transport = createClientTransport();
  const foreign = createClientTransport();
  let enrolled = false;
  const exchange = transport.start({
    ...input(url, new AbortController().signal),
    body: undefined,
    json: {
      get forbidden() {
        assert.equal(enrolled, true);
        throw new Error("not read");
      },
    },
  });
  enrolled = true;
  assert.equal(isClientExchangeForTransport(transport, exchange), true);
  assert.equal(isClientExchangeForTransport(foreign, exchange), false);
  assert.equal(isClientExchangeForTransport(transport, { ...exchange }), false);
  await assert.rejects(exchange.result);
  await exchange.settled;
});

test("all 32 abandoned sent registrations receive their own response and sequential original-authority detach", async (t) => {
  const responses = new Map();
  const detached = new Set();
  const url = await peer(t, (req, res) => {
    assert.equal(req.headers["content-type"], "application/json");
    const token = req.headers.authorization.slice(7);
    if (req.url === "/v1/clients") responses.set(token, res);
    else if (req.url === "/v1/clients/detach") {
      assert.equal(detached.has(token), false);
      detached.add(token);
      json(res, { data: { detached: true } });
    } else assert.fail("unexpected endpoint");
  });
  const states = Array.from({ length: 32 }, (_, i) => {
    const bootstrap = String(i).padStart(2, "0") + "b".repeat(41);
    const actorToken = String(i).padStart(2, "0") + "t".repeat(41);
    const responseProof = deferred();
    const entered = deferred();
    const abort = new AbortController();
    let factoryCalls = 0;
    let ordinarySettled = false;
    let exchanges = 0;
    let sent = 0;
    let published = 0;
    const authority = {
      assertCurrent() {},
      async beforeSend() {
        if (sent === 1)
          assert.equal(
            ordinarySettled,
            true,
            "detach must follow registration physical settlement",
          );
      },
      sent() {
        sent++;
      },
      async afterResponse() {
        if (sent === 1) {
          entered.resolve();
          await responseProof.promise;
        }
      },
      invalidate() {
        assert.fail("caller abandonment must not revoke private sent cleanup authority");
      },
    };
    const client = new ManagementClient(url, bootstrap, {
      expectedKind: "agent",
      automaticHeartbeat: false,
      strictCleanup: true,
      strictLifecycle: true,
      retainSentRegistration: true,
      capacity: { ordinary: 1, control: 1 },
      authority() {
        factoryCalls++;
        return authority;
      },
      onExchange(exchange, owner) {
        assert.equal(owner, authority);
        exchanges++;
        if (exchanges === 1)
          exchange.settled.then(() => {
            ordinarySettled = true;
          });
      },
      onRegistered(identity, _exchange, state) {
        assert.equal(identity.id, `actor-${i}`);
        assert.equal(state.publish, false);
        published++;
      },
    });
    const caller = assert.rejects(
      client.connect(abort.signal),
      (e) => e.code === "CANCELLED_OR_TIMEOUT",
    );
    return {
      client,
      bootstrap,
      actorToken,
      abort,
      caller,
      responseProof,
      entered,
      inspect() {
        assert.equal(factoryCalls, 1);
        assert.equal(exchanges, 2);
        assert.equal(sent, 2);
        assert.equal(published, 1);
      },
    };
  });
  while (responses.size !== 32) await tick();
  for (const state of states) state.abort.abort();
  await Promise.all(states.map((s) => s.caller));
  const closes = states.map((s) => s.client.close());
  states.forEach((s, i) => assert.equal(s.client.close(), closes[i]));
  states.forEach((s, i) =>
    json(responses.get(s.bootstrap), {
      data: {
        token: s.actorToken,
        actor: { id: `actor-${i}`, kind: "agent" },
        expiresInMs: 120000,
      },
    }),
  );
  await Promise.all(states.map((s) => s.entered.promise));
  await tick();
  assert.equal(detached.size, 0);
  for (const state of states) state.responseProof.resolve();
  await Promise.all(closes);
  assert.equal(detached.size, 32);
  for (const state of states) {
    assert.equal(detached.has(state.actorToken), true);
    assert.equal(state.client.registration, undefined);
    state.inspect();
  }
});

test("caller abandonment alone makes late actor private and schedules one cleanup", async (t) => {
  let held;
  let calls = 0;
  let detaches = 0;
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") held = res;
    else if (req.url === "/v1/clients/detach") {
      detaches++;
      json(res, { data: { detached: true } });
    } else {
      calls++;
      json(res, { data: [] });
    }
  });
  const controller = new AbortController();
  const client = new ManagementClient(url, "b".repeat(43), {
    retainSentRegistration: true,
    strictLifecycle: true,
    strictCleanup: true,
    automaticHeartbeat: false,
    onRegistered(_identity, _exchange, state) {
      assert.equal(state.publish, false);
      assert.equal(client.registration, undefined);
    },
  });
  const caller = assert.rejects(
    client.connect(controller.signal),
    (e) => e.code === "CANCELLED_OR_TIMEOUT",
  );
  while (!held) await tick();
  controller.abort();
  await caller;
  json(held, registration);
  while (!detaches) await tick();
  assert.equal(client.registration, undefined);
  await assert.rejects(client.connect(), (e) => e.code === "NOT_CONNECTED");
  await assert.rejects(client.call("ssh_hosts_list", {}), (e) => e.code === "NOT_CONNECTED");
  await client.close();
  assert.equal(detaches, 1);
  assert.equal(calls, 0);
});

test("aborting an unread completed download settles the actual returned stream", async (t) => {
  const url = await peer(t, (_req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(200000));
  });
  const controller = new AbortController();
  const exchange = createClientTransport().start({
    ...input(url, controller.signal),
    method: "GET",
    download: true,
    responseBytes: 1000000,
  });
  const response = await exchange.result;
  await tick();
  controller.abort();
  await exchange.settled;
  await assert.rejects(response.stream.getReader().read());
});

test("early upload response closes the actual source and joins its asynchronous cancellation", async (t) => {
  const canceled = deferred();
  const allowCancel = deferred();
  const url = await peer(t, (_req, res) => json(res, { data: { completed: true } }), {
    keepAliveTimeout: 0,
  });
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
    },
    async cancel() {
      canceled.resolve();
      await allowCancel.promise;
    },
  });
  const controller = new AbortController();
  const exchange = createClientTransport().start({
    ...input(url, controller.signal),
    method: "PUT",
    body: stream,
  });
  const rejected = assert.rejects(exchange.result);
  await canceled.promise;
  let settled = false;
  exchange.settled.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  allowCancel.resolve();
  await rejected;
  await exchange.settled;
});

test("non-enumerable serialization accessors cannot bypass pre-materialization bounds", () => {
  let reads = 0;
  const value = Object.defineProperty({}, "toJSON", {
    get() {
      reads++;
      return () => ({ large: "x".repeat(10000) });
    },
  });
  assert.throws(
    () => serializeClientJson(value, 10),
    (e) => e.code === "API_RESPONSE",
  );
  assert.equal(reads, 0);
  const nested = Object.defineProperty({}, "hidden", {
    get() {
      reads++;
      return "secret";
    },
  });
  assert.throws(() => serializeClientJson({ nested }, 1024));
  assert.equal(reads, 0);
});

test("legacy initial connection failure can explicitly retry", async (t) => {
  let registrations = 0;
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") json(res, ++registrations === 1 ? { data: {} } : registration);
    else json(res, { data: { detached: true } });
  });
  const client = new ManagementClient(url, "b".repeat(43), { automaticHeartbeat: false });
  await assert.rejects(client.connect(), (e) => e.code === "API_RESPONSE");
  await client.connect();
  assert.equal(registrations, 2);
  await client.close();
});

test("array instance methods and proxies cannot execute during serialization", () => {
  let calls = 0;
  const value = [1];
  Object.defineProperty(value, "map", {
    value() {
      calls++;
      throw new Error("must not run");
    },
  });
  assert.equal(serializeClientJson(value, 3), "[1]");
  assert.equal(calls, 0);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        return [];
      },
    },
  );
  assert.throws(() => serializeClientJson(proxy, 10));
  assert.equal(calls, 0);
});

test("legacy reconnect never inherits abandoned registration cleanup authority", async (t) => {
  const hooks = [];
  const authority = (label) => ({
    assertCurrent() {},
    async beforeSend() {},
    async afterResponse() {},
    sent() {
      hooks.push(label);
    },
    invalidate() {},
  });
  const a = authority("A"),
    b = authority("B");
  let first;
  let registrations = 0;
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") {
      if (++registrations === 1) first = res;
      else json(res, registration);
    } else json(res, { data: { detached: true } });
  });
  const client = new ManagementClient(url, "b".repeat(43), {
    automaticHeartbeat: false,
    retainSentRegistration: true,
    strictCleanup: true,
  });
  const abort = new AbortController();
  const caller = assert.rejects(client.connect({ authority: a, signal: abort.signal }));
  while (!first) await tick();
  abort.abort();
  await caller;
  json(first, registration);
  await client.close();
  await client.connect({ authority: b });
  await client.close({ authority: b });
  assert.deepEqual(hooks, ["A", "A", "B", "B"]);
});

test("registration cancellation stops owning a successfully returned client", async (t) => {
  let detaches = 0;
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") json(res, registration);
    else if (req.url === "/v1/clients/detach") {
      detaches++;
      json(res, { data: { detached: true } });
    } else json(res, { data: [] });
  });
  const abort = new AbortController();
  const client = new ManagementClient(url, "b".repeat(43), {
    retainSentRegistration: true,
    automaticHeartbeat: false,
  });
  await client.connect(abort.signal);
  abort.abort();
  assert.equal(client.registration.id, "registered-actor");
  assert.deepEqual(await client.call("ssh_hosts_list", {}), []);
  assert.equal(detaches, 0);
  await client.close();
  assert.equal(detaches, 1);
});

test("shared transport capacity rejects a genuine unsent exchange and reuses only completed work", async (t) => {
  const held = deferred();
  let proofs = 0;
  const entered = deferred();
  const authority = {
    assertCurrent() {},
    async beforeSend() {},
    async afterResponse() {
      if (++proofs === 2) entered.resolve();
      await held.promise;
    },
    invalidate() {},
  };
  const url = await peer(t, (_req, res) => json(res, registration));
  const transport = createClientTransport({ capacity: { ordinary: 2, control: 1 } });
  const a = transport.start(input(url, new AbortController().signal, authority));
  const b = transport.start(input(url, new AbortController().signal, authority));
  await entered.promise;
  const refused = transport.start(input(url, new AbortController().signal, authority));
  assert.equal(isClientExchangeForTransport(transport, refused), true);
  await assert.rejects(refused.result, (error) => error.code === "LIMIT" && error.sent === false);
  await refused.settled;
  assert.equal(proofs, 2);
  held.resolve();
  await Promise.all([a.result, b.result, a.settled, b.settled]);
  const next = transport.start(input(url, new AbortController().signal, authority));
  await next.result;
  await next.settled;
  assert.equal(proofs, 3);
});

test("joining JSON completion retains a decoded result and a failed detach until physical tails", async () => {
  const callTail = deferred(),
    closeTail = deferred();
  const paths = [];
  const transport = {
    start(request) {
      paths.push(request.path);
      const detach = request.path === "/v1/clients/detach";
      return {
        result: detach
          ? Promise.reject(new Error("bad detach"))
          : Promise.resolve({
              ok: true,
              body: request.path === "/v1/clients" ? registration : { data: [] },
            }),
        settled:
          request.path === "/v1/clients"
            ? Promise.resolve()
            : detach
              ? closeTail.promise
              : callTail.promise,
        sent: true,
        responseComplete: !detach,
        cancel() {},
      };
    },
  };
  const client = new ManagementClient("http://127.0.0.1:1/", "b".repeat(43), {
    transport,
    automaticHeartbeat: false,
    strictCleanup: true,
  });
  await client.connect({ joinPhysical: true });
  let callDone = false;
  const call = client.call("ssh_hosts_list", {}, { joinPhysical: true }).then((value) => {
    callDone = true;
    return value;
  });
  await tick();
  assert.equal(callDone, false);
  callTail.resolve();
  assert.deepEqual(await call, []);
  let closeDone = false;
  const closing = client.close();
  const failed = assert.rejects(closing);
  void closing.catch(() => {
    closeDone = true;
  });
  while (!paths.includes("/v1/clients/detach")) await tick();
  await tick();
  assert.equal(closeDone, false);
  closeTail.resolve();
  await failed;
  assert.equal(closeDone, true);
});

test("joined cancelled registration waits for its real response and original-ticket detach", async (t) => {
  let registrationResponse, detachResponse;
  const owners = [];
  const authority = {
    assertCurrent() {},
    async beforeSend() {},
    async afterResponse() {},
    sent() {
      owners.push("original");
    },
    invalidate() {},
  };
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") registrationResponse = res;
    else detachResponse = res;
  });
  const client = new ManagementClient(url, "b".repeat(43), {
    automaticHeartbeat: false,
    retainSentRegistration: true,
    strictCleanup: true,
  });
  const abort = new AbortController();
  let done = false;
  const connected = client.connect({ authority, signal: abort.signal, joinPhysical: true });
  const failed = assert.rejects(connected);
  void connected.catch(() => {
    done = true;
  });
  while (!registrationResponse) await tick();
  abort.abort();
  await tick();
  assert.equal(done, false);
  json(registrationResponse, registration);
  while (!detachResponse) await tick();
  assert.equal(done, false);
  json(detachResponse, { data: { detached: true } });
  await failed;
  assert.deepEqual(owners, ["original", "original"]);
});

test("shared transport rejects unknown runtime capacity classes and incomplete policies", async (t) => {
  assert.throws(
    () => createClientTransport({ capacity: { ordinary: 1 } }),
    (error) => error.code === "LIMIT",
  );
  assert.throws(
    () => createClientTransport({ capacity: { control: 1 } }),
    (error) => error.code === "LIMIT",
  );
  let requests = 0;
  const url = await peer(t, (_req, res) => {
    requests++;
    json(res, registration);
  });
  const transport = createClientTransport({ capacity: { ordinary: 1, control: 1 } });
  const bad = transport.start({
    ...input(url, new AbortController().signal),
    capacityClass: "other",
  });
  await assert.rejects(bad.result, (error) => error.code === "API_RESPONSE" && !error.sent);
  await bad.settled;
  assert.equal(requests, 0);
});

test("cached registered connect joins its original held physical tail", async () => {
  const tail = deferred();
  const transport = {
    start(request) {
      return {
        result: Promise.resolve({
          ok: true,
          body: request.path === "/v1/clients" ? registration : { data: { detached: true } },
        }),
        settled: request.path === "/v1/clients" ? tail.promise : Promise.resolve(),
        sent: true,
        responseComplete: true,
        cancel() {},
      };
    },
  };
  const client = new ManagementClient("http://127.0.0.1:1/", "b".repeat(43), {
    transport,
    automaticHeartbeat: false,
  });
  await client.connect();
  let done = false;
  const connected = client.connect({ joinPhysical: true }).then((value) => {
    done = true;
    return value;
  });
  await tick();
  assert.equal(done, false);
  tail.resolve();
  assert.equal(await connected, client);
  await client.close();
});

test("host prepublication close can retain its original ordinary class after connect returns", async () => {
  const classes = [];
  const transport = {
    start(request) {
      classes.push(request.capacityClass);
      return {
        result: Promise.resolve({
          ok: true,
          body: request.path === "/v1/clients" ? registration : { data: { detached: true } },
        }),
        settled: Promise.resolve(),
        sent: true,
        responseComplete: true,
        cancel() {},
      };
    },
  };
  const client = new ManagementClient("http://127.0.0.1:1/", "b".repeat(43), {
    transport,
    automaticHeartbeat: false,
    strictCleanup: true,
  });
  await client.connect({ joinPhysical: true });
  await client.close({ capacityClass: "ordinary" });
  assert.deepEqual(classes, ["ordinary", "ordinary"]);
});

test("fresh HTTP sockets survive post-response proof then physically close without pooling", async (t) => {
  const { createClientTransport } = await import("../dist/client.js");
  const sockets = new Set();
  const peers = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    peers.push(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const transport = createClientTransport();
  for (let index = 0; index < 2; index++) {
    let checked = false;
    const exchange = transport.start({
      url: `http://127.0.0.1:${server.address().port}/`,
      path: "/v1/proof",
      method: "POST",
      token: "fixture",
      json: {},
      signal: new AbortController().signal,
      requestBytes: 1024,
      responseBytes: 1024,
      authority: {
        assertCurrent() {},
        async beforeSend() {},
        invalidate() {
          assert.fail("healthy peer must remain valid");
        },
        async afterResponse(socket) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(socket.destroyed, false);
          assert.equal(socket.readyState, "open");
          assert.equal(sockets.size, 1);
          checked = true;
        },
      },
    });
    assert.deepEqual(await exchange.result, { ok: true, body: { data: [] } });
    assert.equal(checked, true);
    await exchange.settled;
  }
  assert.equal(peers.length, 2);
  assert.notEqual(peers[0], peers[1]);
});
