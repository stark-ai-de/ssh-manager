import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { ManagementClient } from "../dist/client.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const registration = {
  token: "t".repeat(43),
  actor: { id: "fixture-actor", kind: "agent" },
  expiresInMs: 120000,
};
const reply = (data) => ({ ok: true, body: { data } });
function exchange(response, settled = Promise.resolve()) {
  return {
    result: Promise.resolve(response),
    settled,
    sent: true,
    responseComplete: true,
    cancel() {},
  };
}
function clientFixture(
  options = {},
  start = () => exchange(reply([])),
  url = "http://127.0.0.1:1",
) {
  const requests = [];
  const client = new ManagementClient(url, "b".repeat(43), {
    automaticHeartbeat: false,
    transport: {
      start(request) {
        requests.push(request);
        if (request.path === "/v1/clients") return exchange(reply(registration));
        if (request.path === "/v1/clients/detach") return exchange(reply({ detached: true }));
        return start(request);
      },
    },
    ...options,
  });
  return { client, requests };
}
async function peer(t, handler) {
  const sockets = new Set();
  const server = createServer(handler);
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
  return `http://127.0.0.1:${server.address().port}`;
}
function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function authority() {
  let revocations = 0;
  return {
    assertCurrent() {
      assert.equal(revocations, 0, "revoked owner reused");
    },
    async beforeSend() {},
    async afterResponse() {},
    invalidate() {
      revocations++;
    },
    get revocations() {
      return revocations;
    },
  };
}

test("client rejects missing or invalid capacities before custom transport I/O", async () => {
  for (const capacity of [
    {},
    { ordinary: 1 },
    { control: 1 },
    null,
    false,
    { ordinary: 0, control: 1 },
    { ordinary: 1, control: -1 },
    { ordinary: 1.5, control: 1 },
    { ordinary: 1, control: NaN },
    { ordinary: Infinity, control: 1 },
    { ordinary: 1, control: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const { client, requests } = clientFixture({ capacity });
    await assert.rejects(client.connect(), { code: "INVALID_ARGUMENT" });
    assert.equal(requests.length, 0);
    await client.close();
  }
});

test("custom transport cannot borrow control for other routes; both classes retain physical capacity", async () => {
  const ordinary = deferred(),
    control = deferred();
  const session = {
    id: "session",
    targetId: "target",
    state: "running",
    cols: 80,
    rows: 24,
    tmux: false,
    recording: false,
    createdAt: "fixture",
  };
  const { client, requests } = clientFixture(
    { capacity: { ordinary: 1, control: 1 } },
    (request) =>
      request.path === "/v1/clients/heartbeat"
        ? exchange(reply({ alive: true }), control.promise)
        : request.path === "/v1/ssh_session_detach"
          ? exchange(reply(session))
          : exchange(reply([]), ordinary.promise),
  );
  await client.connect({ joinPhysical: true });
  await client.call("ssh_hosts_list", {});
  await assert.rejects(client.call("ssh_hosts_list", {}), { code: "LIMIT" });
  const before = requests.length;
  for (const capacityClass of ["control", "unknown", "", null, false])
    await assert.rejects(client.call("ssh_hosts_list", {}, { capacityClass }), {
      code: "INVALID_ARGUMENT",
    });
  assert.equal(requests.length, before);
  await client.heartbeat();
  await assert.rejects(client.heartbeat(), { code: "LIMIT" });
  control.resolve();
  await tick();
  await client.call("ssh_session_detach", { sessionId: "session" }, { capacityClass: "control" });
  const detach = requests.find((r) => r.path === "/v1/ssh_session_detach");
  assert.equal(detach.capacityClass, "control");
  assert.equal(detach.responseBytes, 16777216);
  ordinary.resolve();
  await client.close();
  assert.equal(requests.at(-1).path, "/v1/clients/detach");
  assert.equal(requests.at(-1).capacityClass, "control");
});

test("additional cancelled connect waiter never abandons the owner's registration", async () => {
  for (const retainSentRegistration of [false, true]) {
    const result = deferred(),
      physical = deferred();
    let registrations = 0,
      detaches = 0;
    const client = clientFixture({
      retainSentRegistration,
      transport: {
        start(request) {
          if (request.path === "/v1/clients") {
            registrations++;
            return { ...exchange(undefined, physical.promise), result: result.promise };
          }
          detaches++;
          return exchange(reply({ detached: true }));
        },
      },
    }).client;
    const owner = client.connect({ joinPhysical: true });
    const abort = new AbortController();
    const waiter = client.connect({ signal: abort.signal });
    const rejected = assert.rejects(waiter, { code: "CANCELLED_OR_TIMEOUT" });
    abort.abort();
    await rejected;
    assert.equal(detaches, 0);
    result.resolve(reply(registration));
    physical.resolve();
    assert.equal(await owner, client);
    assert.equal(client.registration.kind, "agent");
    assert.equal(registrations, 1);
    assert.equal(detaches, 0);
    await client.close();
    assert.equal(detaches, 1);
  }
});

for (const strictCleanup of [false, true]) {
  test(`close joins every physical tail before reporting cleanup failure (strict=${strictCleanup})`, async () => {
    const failed = deferred(),
      held = deferred();
    let calls = 0;
    const { client } = clientFixture({ strictCleanup }, () =>
      exchange(reply([]), ++calls === 1 ? failed.promise : held.promise),
    );
    await client.connect();
    await client.call("ssh_hosts_list", {});
    await client.call("ssh_hosts_list", {});
    let finished = false;
    const close = client.close();
    assert.equal(client.close(), close);
    const observed = close.then(
      () => {
        finished = true;
      },
      (error) => {
        finished = true;
        return error;
      },
    );
    const failure = new Error("physical cleanup failed");
    failed.reject(failure);
    await tick();
    assert.equal(finished, false);
    held.resolve();
    assert.equal(await observed, strictCleanup ? failure : undefined);
    assert.equal(client.close(), close);
  });
}

test("stream transfers outlive the JSON deadline; explicit timeout and cancellation still stop them", async (t) => {
  const url = await peer(t, (req, res) => {
    if (req.url === "/v1/clients") return json(res, { data: registration });
    if (req.url === "/v1/clients/detach") return json(res, { data: { detached: true } });
    if (req.url === "/v1/clients/heartbeat") return json(res, { data: { alive: true } });
    if (req.url.startsWith("/v1/files/download")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.write("first");
      setTimeout(() => res.end("last"), 50);
    } else if (req.url.startsWith("/v1/files/upload")) {
      req.resume();
      req.on("end", () => setTimeout(() => json(res, { data: { completed: true } }), 50));
    } else json(res, { data: [] });
  });
  const timeout = AbortSignal.timeout.bind(AbortSignal),
    deadlines = [];
  let compressJSONDeadline = false;
  // Compress only the implicit JSON deadline; transfers still use real sockets/streams.
  t.mock.method(AbortSignal, "timeout", (ms) => {
    deadlines.push(ms);
    return timeout(compressJSONDeadline && ms === 30000 ? 10 : ms);
  });
  const client = new ManagementClient(url, "b".repeat(43), { automaticHeartbeat: false });
  t.after(() => client.close());
  await client.connect({ joinPhysical: true });
  await client.call("ssh_hosts_list", {}, { joinPhysical: true });
  await client.heartbeat({ joinPhysical: true });
  compressJSONDeadline = true;
  const upload = () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    });
  assert.deepEqual(await client.upload("target", "file", upload()), { completed: true });
  assert.equal(await new Response(await client.download("target", "file")).text(), "firstlast");
  assert.deepEqual(deadlines, [5000, 30000, 5000]);
  for (const mode of ["timeout", "cancel"]) {
    for (const direction of ["upload", "download"]) {
      const abort = new AbortController();
      const options = mode === "timeout" ? { timeout: 10 } : { signal: abort.signal };
      const work =
        direction === "upload"
          ? client.upload("target", "file", upload(), options)
          : client
              .download("target", "file", options)
              .then((stream) => new Response(stream).text());
      const rejected = assert.rejects(work);
      if (mode === "cancel") setTimeout(() => abort.abort(), 10);
      await rejected;
    }
  }
  await client.close();
  assert.equal(deadlines.at(-1), 2000);
});

for (const perCall of [false, true]) {
  test(`malformed HTTP responses revoke the exact ${perCall ? "per-call" : "constructor"} authority once`, async (t) => {
    for (const body of [
      null,
      [],
      { error: [] },
      { error: { code: "DENIED", message: "denied", details: [] } },
      { data: {} },
    ]) {
      let requests = 0;
      const url = await peer(t, (req, res) => {
        requests++;
        json(
          res,
          req.url === "/v1/clients" ? { data: registration } : body,
          req.url !== "/v1/clients" && body?.error ? 403 : 200,
        );
      });
      const owner = authority();
      const client = new ManagementClient(url, "b".repeat(43), {
        automaticHeartbeat: false,
        ...(perCall ? {} : { authority: () => owner }),
      });
      await client.connect({ joinPhysical: true });
      await assert.rejects(
        client.call(
          "ssh_hosts_list",
          {},
          { ...(perCall ? { authority: owner } : {}), joinPhysical: true },
        ),
        { code: "API_RESPONSE" },
      );
      assert.equal(owner.revocations, 1);
      const before = requests;
      await assert.rejects(client.call("ssh_hosts_list", {}), { code: "NOT_CONNECTED" });
      assert.equal(requests, before);
      await client.close();
    }
  });
}

test("valid remote API errors including API_RESPONSE preserve authority and future calls", async () => {
  const owner = authority();
  let calls = 0;
  const { client } = clientFixture({ authority: () => owner }, () =>
    ++calls < 3
      ? exchange({
          ok: false,
          body: {
            error: {
              code: calls === 1 ? "FORBIDDEN" : "API_RESPONSE",
              message: "remote rejection",
              details: { retry: true },
            },
          },
        })
      : exchange(reply([])),
  );
  await client.connect();
  for (const code of ["FORBIDDEN", "API_RESPONSE"]) {
    await assert.rejects(
      client.call("ssh_hosts_list", {}),
      (error) => error.code === code && error.details.retry,
    );
    assert.equal(owner.revocations, 0);
  }
  assert.deepEqual(await client.call("ssh_hosts_list", {}), []);
  await client.close();
});

test("registration, heartbeat and transfer postconditions revoke sent malformed replies", async () => {
  for (const operation of ["registration", "heartbeat", "upload", "download"]) {
    const owner = authority();
    const { client } = clientFixture(
      {
        authority: () => owner,
        ...(operation === "registration"
          ? {
              transport: { start: () => exchange(reply({ ...registration, actor: {} })) },
            }
          : {}),
      },
      () => (operation === "download" ? exchange({ stream: null }) : exchange(reply({}))),
    );
    if (operation !== "registration") await client.connect();
    const work =
      operation === "registration"
        ? client.connect()
        : operation === "heartbeat"
          ? client.heartbeat()
          : operation === "download"
            ? client.download("target", "file")
            : client.upload(
                "target",
                "file",
                new ReadableStream({
                  start(c) {
                    c.close();
                  },
                }),
              );
    await assert.rejects(work, { code: "API_RESPONSE" });
    assert.equal(owner.revocations, 1);
    await assert.rejects(client.connect(), { code: "NOT_CONNECTED" });
    await client.close();
  }
});

test("an unsent transport rejection does not revoke a per-call authority", async () => {
  const owner = authority();
  const { client } = clientFixture({}, () => ({
    ...exchange(undefined),
    sent: false,
    result: Promise.reject(new Error("unsent")),
  }));
  await client.connect();
  await assert.rejects(client.call("ssh_hosts_list", {}, { authority: owner }));
  assert.equal(owner.revocations, 0);
  assert.equal(client.registration.kind, "agent");
  await client.close();
});

for (const strictCleanup of [false, true]) {
  test(`failed exchange cannot release close while a session socket proof is held (strict=${strictCleanup})`, async (t) => {
    const url = await peer(t, (_req, res) => res.end());
    const physical = deferred(),
      proof = deferred(),
      entered = deferred();
    const { client } = clientFixture(
      { strictCleanup },
      () => exchange(reply([]), physical.promise),
      url,
    );
    await client.connect();
    const stream = client.watchSession("session", {
      authority: {
        assertCurrent() {},
        async beforeSend() {
          entered.resolve();
          await proof.promise;
        },
        async afterResponse() {},
        invalidate() {},
      },
    });
    const rejectedReady = assert.rejects(stream.ready);
    await entered.promise;
    await client.call("ssh_hosts_list", {});
    let finished = false;
    const close = client.close();
    const observed = close.then(
      () => {
        finished = true;
      },
      (error) => {
        finished = true;
        return error;
      },
    );
    const failure = new Error("exchange cleanup failed");
    physical.reject(failure);
    await tick();
    assert.equal(finished, false);
    proof.resolve();
    assert.equal(await observed, strictCleanup ? failure : undefined);
    await rejectedReady;
    await stream.settled;
    assert.equal(client.close(), close);
  });
}

test("valid registration rejection preserves strict lifecycle and legacy retry without authority revocation", async () => {
  for (const mode of ["strict", "authority", "legacy"]) {
    const owner = authority();
    let registrations = 0;
    const { client } = clientFixture({
      ...(mode === "strict" ? { strictLifecycle: true } : {}),
      ...(mode === "authority" ? { authority: () => owner } : {}),
      transport: {
        start(request) {
          if (request.path !== "/v1/clients") return exchange(reply({ detached: true }));
          return ++registrations === 1
            ? exchange({
                ok: false,
                body: { error: { code: "FORBIDDEN", message: "registration refused" } },
              })
            : exchange(reply(registration));
        },
      },
    });
    await assert.rejects(client.connect(), { code: "FORBIDDEN" });
    assert.equal(owner.revocations, 0);
    if (mode === "legacy") {
      await client.connect();
      assert.equal(registrations, 2);
    } else {
      await assert.rejects(client.connect(), { code: "NOT_CONNECTED" });
      assert.equal(registrations, 1);
    }
    await client.close();
  }
});
