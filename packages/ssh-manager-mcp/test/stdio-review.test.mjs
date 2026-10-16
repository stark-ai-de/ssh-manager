import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
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
              : Promise.resolve({ ok: true, body: { data: { detached: true } } }),
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

for (const era of ["legacy", "modern"]) {
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
