import assert from "node:assert/strict";
import test from "node:test";
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
