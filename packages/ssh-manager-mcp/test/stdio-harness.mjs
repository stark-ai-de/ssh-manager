import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { ManagementClient } from "@stark-ai/ssh-manager-runtime/client";
import { serveManagementStdio, createManagementStdioTransport } from "../dist/stdio.js";

export const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "lifecycle-test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
export const tick = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};
// Synthetic transport, real ManagementClient registration/role validation. No SSH claim.
export function fixtureClient(options = {}, kind = "agent") {
  return new ManagementClient("http://127.0.0.1:1", "b".repeat(43), {
    automaticHeartbeat: false,
    transport: {
      start(request) {
        const data =
          request.path === "/v1/clients"
            ? { token: "t".repeat(43), actor: { id: "fixture-actor", kind }, expiresInMs: 120000 }
            : request.path === "/v1/clients/detach"
              ? { detached: true }
              : { alive: true };
        return {
          result: Promise.resolve({ ok: true, body: { data } }),
          settled: Promise.resolve(),
          sent: true,
          responseComplete: true,
          cancel() {},
        };
      },
    },
    ...options,
  });
}
export async function mcpHarness(
  t,
  { era = "legacy", initialize = true, factory, ...options } = {},
) {
  const input = new PassThrough(),
    messages = [],
    pendingWrites = [],
    errors = [];
  let holding = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(JSON.parse(chunk.toString()));
      if (holding) pendingWrites.push(callback);
      else callback();
    },
  });
  const client = fixtureClient();
  const handle = serveManagementStdio({
    transport: createManagementStdioTransport(input, output),
    input: { messageBytes: 1048576, maxMessages: 65536, windowMs: 1000 },
    createClient: async () => {
      await factory;
      return client;
    },
    invoke: async () => [],
    onerror: () => errors.push(true),
    ...options,
  });
  t.after(async () => {
    holding = false;
    for (const callback of pendingWrites.splice(0)) callback();
    await handle.close();
    input.destroy();
    output.destroy();
  });
  const until = async (predicate) => {
    const deadline = performance.now() + 4000;
    while (!predicate()) {
      assert.ok(
        performance.now() < deadline,
        "MCP fixture did not settle: " + JSON.stringify(handle.usage()),
      );
      await tick();
    }
  };
  const send = (message) => input.write(JSON.stringify(message) + "\n");
  const request = (id, method, params = {}) =>
    send({
      jsonrpc: "2.0",
      id,
      method,
      params: era === "modern" ? { ...params, _meta: modernMeta } : params,
    });
  const notify = (method, params = {}) => send({ jsonrpc: "2.0", method, params });
  const call = async (id, method, params) => {
    const start = messages.length;
    request(id, method, params);
    await until(() => messages.slice(start).some((message) => message.id === id));
    const response = messages.slice(start).find((message) => message.id === id);
    // Completion is deliberately stricter than receiving the response.
    await tick();
    return response;
  };
  if (initialize) {
    if (era === "modern") await call("init", "server/discover");
    else {
      await call("init", "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "1" },
      });
      notify("notifications/initialized");
      await tick();
    }
  }
  return {
    handle,
    input,
    output,
    messages,
    errors,
    request,
    notify,
    call,
    until,
    pendingWrites,
    holdWrites(value) {
      holding = value;
      if (!value) for (const callback of pendingWrites.splice(0)) callback();
    },
  };
}
