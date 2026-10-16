import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { createMcpServer } from "@stark-ai/ssh-manager-mcp";
import { serveManagementStdio, createManagementStdioTransport } from "../dist/stdio.js";
import { fixtureClient, mcpHarness, tick } from "./stdio-harness.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const initialize = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "review-fixture", version: "1" },
};
function registrationClient({ result, settled, kind = "agent", onStart = () => {} } = {}) {
  return fixtureClient({
    retainSentRegistration: true,
    transport: {
      start(request) {
        onStart(request);
        return {
          result:
            request.path === "/v1/clients"
              ? (result ??
                Promise.resolve({
                  ok: true,
                  body: {
                    data: {
                      token: "t".repeat(43),
                      actor: { id: "fixture-actor", kind },
                      expiresInMs: 120000,
                    },
                  },
                }))
              : Promise.resolve({
                  ok: true,
                  body: { data: request.path === "/v1/ssh_hosts_list" ? [] : { detached: true } },
                }),
          settled:
            request.path === "/v1/clients" ? (settled ?? Promise.resolve()) : Promise.resolve(),
          sent: true,
          responseComplete: true,
          cancel() {},
        };
      },
    },
  });
}

test("public package-root factory requires a physically registered agent for every invocation", async (t) => {
  for (const custom of [false, true]) {
    for (const mode of ["agent", "operator", "failed", "cancelled", "closed"]) {
      await t.test(`${mode}, custom=${custom}`, async (t) => {
        const physical = deferred();
        let invoked = 0,
          policyCalls = 0;
        const requests = [],
          messages = [];
        const client = registrationClient({
          kind: mode === "operator" ? "operator" : "agent",
          ...(mode === "failed"
            ? { result: Promise.resolve({ ok: true, body: { data: {} } }) }
            : {}),
          settled: physical.promise,
          onStart: (request) => requests.push(request.path),
        });
        const server = createMcpServer(client, {
          beforeCall: async () => {
            policyCalls++;
          },
          ...(custom
            ? {
                invoke: async () => {
                  invoked++;
                  return [];
                },
              }
            : {}),
        });
        const wire = {
          async start() {},
          async send(message) {
            messages.push(message);
          },
          async close() {
            wire.onclose?.();
          },
        };
        t.after(async () => {
          physical.resolve();
          await server.close();
          await client.close();
        });
        await server.connect(wire);
        wire.onmessage({ jsonrpc: "2.0", id: "init", method: "initialize", params: initialize });
        await tick();
        assert.ok(messages.find((m) => m.id === "init")?.result);
        wire.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
        wire.onmessage({
          jsonrpc: "2.0",
          id: "invalid",
          method: "tools/call",
          params: { name: "ssh_hosts_list", arguments: { actor: true } },
        });
        await tick();
        assert.equal(policyCalls, 0);
        assert.deepEqual(requests, []);
        wire.onmessage({
          jsonrpc: "2.0",
          id: "tool",
          method: "tools/call",
          params: { name: "ssh_hosts_list", arguments: {} },
        });
        await tick();
        assert.equal(policyCalls, 1);
        assert.equal(invoked, 0, "custom callback must wait for registration physical completion");
        assert.deepEqual(requests, ["/v1/clients"]);
        if (mode === "cancelled")
          wire.onmessage({
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: "tool" },
          });
        if (mode === "closed") void client.close();
        await tick();
        physical.resolve();
        await tick();
        assert.equal(invoked, custom && mode === "agent" ? 1 : 0);
        assert.equal(requests.includes("/v1/ssh_hosts_list"), !custom && mode === "agent");
        if (mode !== "cancelled") {
          const response = messages.find((m) => m.id === "tool");
          assert.ok(response);
          assert.equal(response.result.isError, mode === "agent" ? undefined : true);
          if (mode === "agent") assert.deepEqual(response.result.structuredContent, { data: [] });
          if (mode === "operator")
            assert.equal(JSON.parse(response.result.content[0].text).error.code, "FORBIDDEN");
        }
      });
    }
  }
});

for (const era of ["legacy", "modern"]) {
  test(`${era}: physical registration stays inside the active tool-handler budget`, async (t) => {
    const physical = deferred();
    let policyCalls = 0,
      invoked = 0;
    const client = registrationClient({ settled: physical.promise });
    t.after(() => physical.resolve());
    const h = await mcpHarness(t, {
      era,
      createClient: () => client,
      beforeCall: async () => {
        policyCalls++;
      },
      invoke: async () => {
        invoked++;
        return [];
      },
    });
    for (const id of [1, 2, 3])
      h.request(id, "tools/call", { name: "ssh_hosts_list", arguments: {} });
    await h.until(() => h.handle.usage().waitingCalls === 1);
    assert.equal(h.handle.usage().calls, 2);
    assert.equal(policyCalls, 2);
    assert.equal(invoked, 0);
    physical.resolve();
    await h.until(() => h.messages.filter((m) => [1, 2, 3].includes(m.id)).length === 3);
    assert.equal(invoked, 3);
    assert.equal(h.handle.usage().calls, 0);
  });

  test(`${era}: natural EOF finalizes adapter listeners and preserves shared output`, async (t) => {
    const h = await mcpHarness(t, { era });
    h.holdWrites(true);
    h.request("held", "ping");
    await h.until(() => h.pendingWrites.length === 1);
    h.input.end();
    await tick();
    let finished = false;
    const close = h.handle.close();
    assert.equal(h.handle.close(), close);
    close.then(() => {
      finished = true;
    });
    await tick();
    assert.equal(finished, false, "EOF must join the physical output callback");
    h.holdWrites(false);
    await close;
    for (const event of ["data", "end", "error", "close"])
      assert.equal(h.input.listenerCount(event), 0, `input ${event}`);
    for (const event of ["error", "finish", "close"])
      assert.equal(h.output.listenerCount(event), 0, `output ${event}`);
    assert.equal(h.output.destroyed, false);
    assert.equal(h.output.writableEnded, false);
    await new Promise((resolve, reject) =>
      h.output.write('{"shared":true}\n', (error) => (error ? reject(error) : resolve())),
    );
    assert.deepEqual(h.messages.at(-1), { shared: true });
    assert.equal(h.handle.usage().clients, 0);
  });

  test(`${era}: custom invocation requires registered agent role and successful registration`, async (t) => {
    for (const mode of ["operator", "failed", "cancelled", "agent"]) {
      await t.test(mode, async (t) => {
        const physical = deferred();
        let starts = 0,
          invocations = 0;
        const client = registrationClient({
          kind: mode === "operator" ? "operator" : "agent",
          ...(mode === "failed"
            ? { result: Promise.resolve({ ok: true, body: { data: {} } }) }
            : {}),
          settled: physical.promise,
          onStart(request) {
            if (request.path === "/v1/clients") starts++;
          },
        });
        const h = await mcpHarness(t, {
          era,
          createClient: () => client,
          invoke: async () => {
            invocations++;
            return [];
          },
        });
        h.request("tool", "tools/call", { name: "ssh_hosts_list", arguments: {} });
        await h.until(() => starts === 1);
        await tick();
        assert.equal(invocations, 0, "physical registration must finish before invoke");
        if (mode === "cancelled") {
          h.notify("notifications/cancelled", { requestId: "tool" });
          await tick();
        }
        physical.resolve();
        await h.until(() => h.handle.usage().calls === 0);
        await tick();
        assert.equal(invocations, mode === "agent" ? 1 : 0);
        if (mode !== "cancelled") {
          const response = h.messages.find((m) => m.id === "tool");
          assert.ok(response);
          assert.equal(response.result.isError, mode === "agent" ? undefined : true);
        }
      });
    }
  });

  test(`${era}: first malformed frame closes admission before the next frame in the same chunk`, async (t) => {
    for (const frame of [
      "{invalid json",
      JSON.stringify({ jsonrpc: "2.0", id: "bad", method: 7, padding: "x".repeat(4096) }),
    ]) {
      await t.test(frame.startsWith("{invalid") ? "JSON" : "envelope", async (t) => {
        const h = await mcpHarness(t, {
          era,
          input: { messageBytes: 1024, maxMessages: 16, windowMs: 1000 },
        });
        const ping = JSON.stringify({ jsonrpc: "2.0", id: "after-invalid", method: "ping" });
        h.input.write(frame + "\n" + ping + "\n");
        await h.until(() => h.errors.length > 0);
        await h.handle.close();
        assert.equal(
          h.messages.some((m) => m.id === "after-invalid"),
          false,
        );
        assert.equal(h.handle.usage().clients, 0);
        assert.equal(h.handle.usage().messages, 0);
      });
    }
  });

  test(`${era}: valid envelopes with invalid tool arguments keep ordinary MCP error semantics`, async (t) => {
    let invoked = 0;
    const h = await mcpHarness(t, {
      era,
      invoke: async () => {
        invoked++;
        return [];
      },
    });
    const invalid = await h.call(1, "tools/call", {
      name: "ssh_hosts_list",
      arguments: { actor: true },
    });
    assert.ok(invalid.error || invalid.result?.isError);
    assert.equal(invoked, 0);
    assert.ok((await h.call(2, "tools/list")).result);
    assert.equal(h.errors.length, 0);
  });
}

test("direct adapter EOF and repeated close share one physical finalizer", async (t) => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const wire = createManagementStdioTransport(input, output);
  let closed = 0;
  wire.onclose = () => {
    closed++;
  };
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  await wire.start();
  input.end();
  await tick();
  assert.equal(closed, 1);
  const close = wire.close();
  assert.equal(wire.close(), close);
  await close;
  assert.equal(closed, 1);
  for (const event of ["data", "end"]) assert.equal(input.listenerCount(event), 0);
  for (const event of ["error", "finish", "close"]) assert.equal(output.listenerCount(event), 0);
  assert.equal(output.destroyed, false);
});

test("explicit adapter close stops input synchronously", async (t) => {
  const input = new PassThrough();
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const wire = createManagementStdioTransport(input, output);
  let received = 0;
  wire.onmessage = () => {
    received++;
  };
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  await wire.start();
  const close = wire.close();
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  assert.equal(received, 0);
  await close;
});

test("modern probe to legacy fallback retains every client until all cleanup attempts finish", async (t) => {
  const held = deferred(),
    clients = [],
    attempted = [];
  const h = await mcpHarness(t, {
    era: "modern",
    createClient() {
      const client = fixtureClient();
      clients.push(client);
      return client;
    },
    async closeClient(client) {
      attempted.push(client);
      if (client === clients[0]) throw new Error("unresolved first detach");
      await held.promise;
      await client.close();
    },
  });
  h.input.write(
    JSON.stringify({ jsonrpc: "2.0", id: "legacy", method: "initialize", params: initialize }) +
      "\n",
  );
  await h.until(() => clients.length === 2 && h.messages.some((m) => m.id === "legacy"));
  assert.equal(h.handle.usage().clients, 2);
  let finished = false;
  const close = h.handle.close();
  const rejected = assert.rejects(close, { code: "API_UNAVAILABLE" }).then(() => {
    finished = true;
  });
  h.handle.close = () => close.catch(() => {});
  await h.until(() => attempted.length === 2);
  await tick();
  assert.equal(finished, false);
  held.resolve();
  await rejected;
  assert.equal(h.handle.usage().clients, 1, "failed cleanup remains charged");
});

test("a handler response created after close begins retains ownership through its actual write callback", async (t) => {
  const start = deferred(),
    invocation = deferred(),
    messages = [],
    callbacks = [];
  const input = new PassThrough();
  let hold = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(JSON.parse(chunk.toString()));
      if (hold) callbacks.push(callback);
      else callback();
    },
  });
  const wire = createManagementStdioTransport(input, output);
  const actualStart = wire.start.bind(wire);
  // Public transport startup may still own work while the official decoder dispatches.
  wire.start = async () => {
    await actualStart();
    await start.promise;
  };
  const handle = serveManagementStdio({
    transport: wire,
    createClient: () => fixtureClient(),
    invoke: async () => {
      await invocation.promise;
      return [];
    },
  });
  t.after(async () => {
    start.resolve();
    invocation.resolve();
    hold = false;
    for (const callback of callbacks.splice(0)) callback();
    await handle.close();
    input.destroy();
    output.destroy();
  });
  const until = async (predicate) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) {
      assert.ok(performance.now() < deadline);
      await tick();
    }
  };
  input.write(
    JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: initialize }) + "\n",
  );
  await until(() => messages.some((m) => m.id === "init"));
  input.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "late",
      method: "tools/call",
      params: { name: "ssh_hosts_list", arguments: {} },
    }) + "\n",
  );
  await until(() => handle.usage().calls === 1);
  hold = true;
  let finished = false;
  const close = handle.close().then(() => {
    finished = true;
  });
  invocation.resolve();
  await until(() => callbacks.length === 1);
  assert.ok(messages.find((m) => m.id === "late")?.result);
  start.resolve();
  await tick();
  assert.equal(finished, false);
  assert.equal(handle.usage().outputMessages, 1);
  callbacks.shift()();
  await close;
  assert.equal(handle.usage().outputMessages, 0);
});

test("malformed input joins both a held invocation and a held client cleanup", async (t) => {
  const invocation = deferred(),
    cleanup = deferred();
  let cleanupStarted = false;
  const h = await mcpHarness(t, {
    invoke: async () => {
      await invocation.promise;
      return [];
    },
    closeClient: async (client) => {
      cleanupStarted = true;
      await cleanup.promise;
      await client.close();
    },
  });
  h.request(1, "tools/call", { name: "ssh_hosts_list", arguments: {} });
  await h.until(() => h.handle.usage().calls === 1);
  h.input.write("{invalid JSON}\n");
  await h.until(() => cleanupStarted && h.errors.length > 0);
  const close = h.handle.close();
  assert.equal(h.handle.close(), close);
  let finished = false;
  close.then(() => {
    finished = true;
  });
  cleanup.resolve();
  await tick();
  assert.equal(finished, false);
  invocation.resolve();
  await close;
  assert.equal(h.handle.usage().clients, 0);
  assert.equal(h.handle.usage().calls, 0);
});

test("official decoder accepts split UTF-8 frames and fails closed on a truncated final frame", async (t) => {
  const h = await mcpHarness(t);
  const message = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: "split-é", method: "ping" }) + "\n",
  );
  const split = message.indexOf(Buffer.from("é")) + 1;
  h.input.write(message.subarray(0, split));
  h.input.write(message.subarray(split));
  await h.until(() => h.messages.some((m) => m.id === "split-é"));
  assert.equal(h.errors.length, 0);
  h.input.end('{"jsonrpc":');
  await h.until(() => h.errors.length > 0);
  await h.handle.close();
});
