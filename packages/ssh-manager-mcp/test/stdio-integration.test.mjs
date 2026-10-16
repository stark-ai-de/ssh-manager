import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ManagementClient } from "@stark-ai/ssh-manager-runtime/client";
import { PassThrough, Writable } from "node:stream";
import {
  serveManagementStdio,
  createManagementStdioTransport,
  supportsReusableManagementStdio,
} from "../dist/stdio.js";
import { catalog } from "@stark-ai/ssh-manager-runtime/catalog";
import { fixtureClient, mcpHarness, tick } from "./stdio-harness.mjs";

for (const era of ["legacy", "modern"]) {
  test(`${era}: published SDK supports canonical tools and thousands of reusable bounded requests`, async (t) => {
    assert.equal(supportsReusableManagementStdio, true);
    const h = await mcpHarness(t, { era });
    const listed = await h.call(1, "tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name).sort(),
      Object.entries(catalog)
        .filter(([, entry]) => !entry.operator)
        .map(([name]) => name)
        .sort(),
    );
    for (let i = 0; i < 2049; i++) {
      const result = await h.call(1, "tools/call", { name: "ssh_hosts_list", arguments: {} });
      assert.deepEqual(result.result.structuredContent, { data: [] });
      assert.equal(h.handle.usage().requests, 0);
    }
    assert.equal(h.errors.length, 0);
    assert.equal(h.handle.usage().clients, 1);
    assert.equal(h.handle.usage().messages, 0);
  });

  test(`${era}: eight cancelled handlers keep IDs and capacity until actual settlement`, async (t) => {
    const releases = [],
      signals = [];
    const h = await mcpHarness(t, {
      era,
      work: { maxCalls: 8, maxWaiting: 8 },
      async invoke(_operation, context) {
        signals.push(context.mcpReq.signal);
        await new Promise((resolve) => releases.push(resolve));
        return [];
      },
    });
    for (let id = 1; id <= 8; id++)
      h.request(id, "tools/call", { name: "ssh_hosts_list", arguments: {} });
    await h.until(() => releases.length === 8);
    for (let id = 1; id <= 8; id++) h.notify("notifications/cancelled", { requestId: id });
    await h.until(() => signals.every((signal) => signal.aborted));
    await tick();
    assert.equal(h.handle.usage().requests, 8);
    assert.equal(h.handle.usage().handlers, 8);
    releases.splice(0).forEach((release) => release());
    await h.until(() => h.handle.usage().messages === 0);
    const result = await h.call(1, "tools/list");
    assert.ok(result.result);
    assert.equal(h.errors.length, 0);
  });

  test(`${era}: cancellation of invalid tools and failed handlers does not leak IDs`, async (t) => {
    const h = await mcpHarness(t, {
      era,
      async invoke() {
        throw new Error("private failure");
      },
    });
    for (const params of [
      { name: "unknown" },
      { name: "ssh_hosts_list", arguments: { actor: true } },
    ]) {
      h.request(1, "tools/call", params);
      h.notify("notifications/cancelled", { requestId: 1 });
      await h.until(() => h.handle.usage().messages === 0);
    }
    assert.ok((await h.call(1, "unknown-method")).error);
    const failed = await h.call(1, "tools/call", { name: "ssh_hosts_list", arguments: {} });
    assert.equal(failed.result.isError, true);
    assert.ok(!JSON.stringify(failed).includes("private failure"));
    assert.ok((await h.call(1, "tools/list")).result);
  });
}

test("ninth request cannot enter while eight cancelled handlers still own work", async (t) => {
  const releases = [];
  const h = await mcpHarness(t, {
    work: { maxCalls: 8, maxWaiting: 8 },
    async invoke() {
      await new Promise((resolve) => releases.push(resolve));
      return [];
    },
  });
  for (let id = 1; id <= 8; id++)
    h.request(id, "tools/call", { name: "ssh_hosts_list", arguments: {} });
  await h.until(() => releases.length === 8);
  for (let id = 1; id <= 8; id++) h.notify("notifications/cancelled", { requestId: id });
  await h.until(() => h.handle.usage().messages === 8);
  h.request(9, "ping");
  await tick();
  assert.equal(h.errors.length, 1);
  assert.equal(h.handle.usage().requests, 8);
  let closed = false;
  const closing = h.handle.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  releases.splice(0).forEach((release) => release());
  await closing;
});

test("blocked policy and late client creation remain owned across concurrent close", async (t) => {
  let allowFactory, allowPolicy;
  const factory = new Promise((resolve) => {
    allowFactory = resolve;
  });
  const h = await mcpHarness(t, {
    initialize: false,
    factory,
    beforeCall: () =>
      new Promise((resolve) => {
        allowPolicy = resolve;
      }),
  });
  h.request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  h.request(2, "tools/call", { name: "ssh_hosts_list", arguments: {} });
  await tick();
  assert.equal(h.handle.usage().factories, 1);
  assert.equal(h.handle.usage().requests, 2);
  allowFactory();
  await h.until(() => !!allowPolicy);
  let closed = false;
  const closing = h.handle.close().then(() => {
    closed = true;
  });
  assert.equal(h.handle.close(), h.handle.close());
  await tick();
  assert.equal(closed, false);
  allowPolicy();
  await closing;
  assert.equal(h.handle.usage().handlers, 0);
});

test("real official stdio retains a response until its Writable callback completes", async (t) => {
  const h = await mcpHarness(t);
  h.holdWrites(true);
  h.request(1, "ping");
  await h.until(() => h.pendingWrites.length === 1);
  await tick();
  assert.equal(h.handle.usage().requests, 1);
  assert.equal(h.handle.usage().outputMessages, 1);
  let closed = false;
  const closing = h.handle.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  h.holdWrites(false);
  await closing;
});

test("modern listen IDs survive ACK and blocked cancellation dispatch, then become reusable", async (t) => {
  const h = await mcpHarness(t, { era: "modern" });
  h.holdWrites(true);
  h.request(1, "subscriptions/listen", { notifications: { tools: { listChanged: true } } });
  await h.until(() => h.pendingWrites.length === 1);
  h.notify("notifications/cancelled", { requestId: 1 });
  await tick();
  assert.equal(h.handle.usage().requests, 1);
  assert.equal(h.handle.usage().messages, 2);
  h.holdWrites(false);
  await h.until(() => h.handle.usage().messages === 0);
  assert.ok((await h.call(1, "tools/list")).result);
  h.request(1, "subscriptions/listen", { notifications: { tools: { listChanged: true } } });
  await h.until(
    () =>
      h.messages.filter((message) => message.method === "notifications/subscriptions/acknowledged")
        .length === 2,
  );
  await tick();
  assert.equal(h.handle.usage().requests, 1);
  h.holdWrites(true);
  let closed = false;
  const closing = h.handle.close().then(() => {
    closed = true;
  });
  await h.until(() => h.pendingWrites.length === 1);
  await tick();
  assert.equal(closed, false);
  h.holdWrites(false);
  await closing;
  assert.equal(h.messages.at(-1).id, 1);
  assert.equal(h.messages.at(-1).result.resultType, "complete");
});

test("invalid admission policy fails before any input or client factory", () => {
  for (const admission of [{}, { maxRequests: 8 }, { maxRequests: 0, maxMessages: 16 }]) {
    let starts = 0,
      clients = 0;
    const wire = {
      async start() {
        starts++;
      },
      async close() {},
      async send() {},
    };
    assert.throws(
      () =>
        serveManagementStdio({
          createClient() {
            clients++;
            throw new Error();
          },
          transport: wire,
          admission,
        }),
      (error) => error.code === "INVALID_ARGUMENT",
    );
    assert.equal(starts, 0);
    assert.equal(clients, 0);
  }
});

test("stdio close joins actual held output transmission", async () => {
  let finish;
  const write = new Promise((resolve) => {
    finish = resolve;
  });
  let sending;
  const started = new Promise((resolve) => {
    sending = resolve;
  });
  const wire = {
    async start() {},
    async close() {},
    async send() {
      sending();
      await write;
    },
  };
  const handle = serveManagementStdio({
    createClient() {
      throw new Error("not served");
    },
    legacy: "reject",
    transport: wire,
  });
  wire.onmessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  await started;
  let closed = false;
  const close = handle.close();
  close.then(() => {
    closed = true;
  });
  assert.equal(handle.close(), close);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  finish();
  await close;
  assert.equal(closed, true);
});

test("an asynchronous reporting failure cannot escape or interrupt owner close", async () => {
  let reported = 0;
  const wire = { async start() {}, async close() {}, async send() {} };
  const handle = serveManagementStdio({
    transport: wire,
    createClient() {
      throw new Error("unused factory");
    },
    async onerror() {
      reported++;
      throw new Error("reporting failed");
    },
  });
  assert.doesNotThrow(() => wire.onerror(new Error("wire failure")));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported, 1);
  await handle.close();
});

test("canonical beforeCall sees validated arguments before any creating registration or tool request", async (t) => {
  let policyDone = false,
    requests = 0;
  const server = createServer((req, res) => {
    assert.equal(policyDone, true);
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/clients"
          ? {
              data: {
                token: "t".repeat(43),
                actor: { id: "policy-actor", kind: "agent" },
                expiresInMs: 120000,
              },
            }
          : req.url === "/v1/clients/detach"
            ? { data: { detached: true } }
            : { data: [] },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const replies = new Map();
  let resolveReply;
  const wire = {
    async start() {},
    async close() {},
    async send(message) {
      replies.set(message.id, message);
      resolveReply?.();
    },
  };
  const handle = serveManagementStdio({
    transport: wire,
    createClient: () =>
      new ManagementClient(`http://127.0.0.1:${server.address().port}`, "b".repeat(43), {
        automaticHeartbeat: false,
        strictCleanup: true,
      }),
    async beforeCall(operation, context, args) {
      assert.equal(operation, "ssh_hosts_list");
      assert.deepEqual(args, { search: "policy-search" });
      assert.equal(context.mcpReq.signal.aborted, false);
      assert.equal(requests, 0);
      policyDone = true;
    },
  });
  t.after(() => handle.close());
  const message = async (id, method, params) => {
    const response = new Promise((resolve) => (resolveReply = resolve));
    wire.onmessage({ jsonrpc: "2.0", id, method, params });
    await response;
    return replies.get(id);
  };
  await message(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "policy-test", version: "1" },
  });
  wire.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  const result = await message(2, "tools/call", {
    name: "ssh_hosts_list",
    arguments: { search: "policy-search" },
  });
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(result.result.structuredContent, { data: [] });
  assert.equal(requests, 2);
  await handle.close();
});

// Real official SDK dispatch. Delayed embedding invocation proves queue/cleanup ownership only,
// not native receipts or SSH qualification.
test("scoped invocation limits work to two and retains close through invocation and embedding cleanup", async () => {
  const pending = new Map(),
    started = [],
    leaves = [];
  let active = 0,
    peak = 0,
    releaseCleanup;
  const cleanup = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupStarted = false;
  const client = fixtureClient();
  const wire = {
    async start() {},
    async close() {},
    async send(message) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    },
  };
  const handle = serveManagementStdio({
    transport: wire,
    createClient: () => client,
    work: { maxCalls: 2, maxWaiting: 8 },
    async invoke(operation, context, args, actual) {
      assert.equal(actual, client);
      assert.equal(operation, "ssh_hosts_list");
      started.push(args.search);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => leaves.push(resolve));
      active--;
      return [];
    },
    async closeClient(actual) {
      assert.equal(actual, client);
      cleanupStarted = true;
      await cleanup;
      await actual.close();
    },
  });
  const send = (id, method, params) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      wire.onmessage({ jsonrpc: "2.0", id, method, params });
    });
  await send(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "scoped-owner", version: "1" },
  });
  wire.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  const calls = [2, 3, 4].map((id) =>
    send(id, "tools/call", { name: "ssh_hosts_list", arguments: { search: String(id) } }),
  );
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  assert.equal(started.length, 2);
  assert.equal(peak, 2);
  leaves.shift()();
  await calls[0];
  for (let index = 0; index < 2; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 3);
  assert.equal(active, 2);
  let done = false;
  const closed = handle.close().then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  for (const resolve of leaves.splice(0)) resolve();
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupStarted, true);
  assert.equal(done, false);
  releaseCleanup();
  await closed;
  assert.equal(done, true);
  assert.equal(peak, 2);
});

test("incomplete work policies deny before transport or client work", () => {
  for (const work of [
    {},
    { maxCalls: 2 },
    { maxWaiting: 8 },
    { maxCalls: 2, maxWaiting: 0 },
    { maxCalls: NaN, maxWaiting: 8 },
  ]) {
    let starts = 0,
      factories = 0,
      invocations = 0;
    const wire = {
      async start() {
        starts++;
      },
      async close() {},
      async send() {},
    };
    assert.throws(
      () =>
        serveManagementStdio({
          transport: wire,
          work,
          createClient() {
            factories++;
            throw new Error("unreachable");
          },
          async invoke() {
            invocations++;
            return [];
          },
        }),
      (e) => e.code === "INVALID_ARGUMENT",
    );
    assert.deepEqual([starts, factories, invocations], [0, 0, 0]);
  }
});

test("late factory and unresolved client cleanup cannot be forgotten during close", async (t) => {
  let allowFactory;
  const h = await mcpHarness(t, {
    initialize: false,
    factory: new Promise((resolve) => {
      allowFactory = resolve;
    }),
    async closeClient() {
      throw new Error("unknown detach");
    },
  });
  h.request(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  await tick();
  assert.equal(h.handle.usage().factories, 1);
  let settled = false;
  const close = h.handle.close();
  close.catch(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false);
  allowFactory();
  await assert.rejects(close, (error) => error.code === "API_UNAVAILABLE");
  assert.equal(h.handle.usage().clients, 1);
  // The fixture's automatic close must observe the same reported failure.
  h.handle.close = () => close.catch(() => {});
});

test("callback write failure stops admission and close joins real handler tails", async (t) => {
  const h = await mcpHarness(t);
  h.holdWrites(true);
  h.request(1, "tools/list");
  await h.until(() => h.pendingWrites.length === 1);
  h.pendingWrites.shift()(new Error("output failed"));
  await h.until(() => h.errors.length > 0);
  await h.handle.close();
  assert.equal(h.handle.usage().requests, 0);
});

test("request ID collision and finite input/output limits close admission", async (t) => {
  for (const kind of ["collision", "input", "output", "rate"]) {
    await t.test(kind, async (t) => {
      const h = await mcpHarness(
        t,
        kind === "output"
          ? { output: { messageBytes: 1000, queuedBytes: 2000, maxMessages: 2 } }
          : kind === "input"
            ? { input: { messageBytes: 512, maxMessages: 64, windowMs: 1000 } }
            : kind === "rate"
              ? { input: { messageBytes: 1048576, maxMessages: 3, windowMs: 100000 } }
              : {},
      );
      if (kind === "collision") {
        h.holdWrites(true);
        h.request(1, "tools/list");
        await h.until(() => h.pendingWrites.length === 1);
        h.request(1, "tools/list");
      } else if (kind === "input") h.request(1, "tools/list", { extra: "x".repeat(1024) });
      else if (kind === "rate") {
        h.notify("ignored");
        h.notify("ignored");
      } else h.request(1, "tools/list");
      await h.until(() => h.errors.length > 0);
      h.holdWrites(false);
      await h.handle.close();
    });
  }
});

test("direct official transport sends join their own callbacks and remove completed error listeners", async () => {
  const input = new PassThrough(),
    callbacks = [];
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callbacks.push(callback);
    },
  });
  const baseline = output.listenerCount("error");
  const transport = createManagementStdioTransport(input, output);
  await transport.start();
  let first = false,
    second = false;
  const a = transport.send({ jsonrpc: "2.0", id: 1, result: {} }).then(() => {
    first = true;
  });
  const b = transport.send({ jsonrpc: "2.0", id: 2, result: {} }).then(() => {
    second = true;
  });
  await tick();
  assert.equal(callbacks.length, 1);
  assert.equal(first, false);
  assert.equal(second, false);
  callbacks.shift()();
  await a;
  await tick();
  assert.equal(callbacks.length, 1);
  assert.equal(second, false);
  callbacks.shift()();
  await b;
  await transport.close();
  assert.equal(output.listenerCount("error"), baseline);
  input.destroy();
  output.destroy();
});

for (const emitClose of [true, false]) {
  test(`failed output stays owned through actual asynchronous destroy (emitClose=${emitClose})`, async () => {
    const input = new PassThrough();
    let failWrite, finishDestroy;
    const output = new Writable({
      emitClose,
      write(_chunk, _encoding, callback) {
        failWrite = callback;
      },
      destroy(error, callback) {
        finishDestroy = () => callback(error);
      },
    });
    const transport = createManagementStdioTransport(input, output);
    await transport.start();
    let sent = false,
      closed = false;
    const write = transport.send({ jsonrpc: "2.0", id: 1, result: {} });
    write.catch(() => {
      sent = true;
    });
    await tick();
    failWrite(new Error("held physical destroy"));
    await tick();
    const close = transport.close();
    close.catch(() => {
      closed = true;
    });
    await tick();
    assert.equal(sent, false);
    assert.equal(closed, false);
    assert.ok(output.listenerCount("error") >= 1);
    finishDestroy();
    await assert.rejects(write, /held physical destroy/);
    await assert.rejects(close, /held physical destroy/);
    assert.equal(output.closed, true);
    assert.equal(output.listenerCount("error"), 0);
    input.destroy();
  });
}

test("incomplete input/output policies fail before transport or factory work", () => {
  for (const policy of [
    { input: {} },
    { input: { messageBytes: 1048576, windowMs: 1000 } },
    { input: { messageBytes: 1048576, maxMessages: 64 } },
    { output: {} },
    { output: { maxMessages: 2 } },
    { output: { messageBytes: 1048576, maxMessages: 2 } },
  ]) {
    let starts = 0,
      clients = 0;
    const wire = {
      async start() {
        starts++;
      },
      async close() {},
      async send() {},
    };
    assert.throws(
      () =>
        serveManagementStdio({
          ...policy,
          transport: wire,
          createClient() {
            clients++;
            throw new Error();
          },
        }),
      (error) => error.code === "INVALID_ARGUMENT",
    );
    assert.equal(starts, 0);
    assert.equal(clients, 0);
  }
});
