import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ManagementClient } from "@stark-ai/ssh-manager-runtime/client";
import { serveManagementStdio } from "../dist/stdio.js";

test("unreleased SDK completion support is denied before any input or client factory", () => {
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
        admission: { maxRequests: 8, maxMessages: 16 },
      }),
    (e) => e.code === "UNSUPPORTED_SDK",
  );
  assert.equal(starts, 0);
  assert.equal(clients, 0);
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
