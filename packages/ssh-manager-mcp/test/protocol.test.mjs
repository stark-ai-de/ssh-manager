import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../ssh-manager-runtime/dist/server.js";
import { catalog } from "../../ssh-manager-runtime/dist/catalog.js";

async function harness(t, bundle = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-mcp-test-"));
  const runtime = await createRuntime({ stateDirectory: directory, knownHosts: [] });
  fs.writeFileSync(
    path.join(directory, "runtime.json"),
    JSON.stringify({ url: runtime.url, pid: process.pid }),
  );
  const entry = bundle
    ? path.resolve("dist/ssh-runtime/mcp.mjs")
    : new URL("../dist/main.js", import.meta.url);
  const processHandle = spawn(
    process.execPath,
    [entry instanceof URL ? fileURLToPath(entry) : entry, "--state-directory", directory],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    sequence = 0,
    stderr = "";
  const waiting = new Map();
  processHandle.stderr.on("data", (data) => (stderr += data));
  processHandle.stdout.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const line = buffer.slice(0, buffer.indexOf("\n"));
      buffer = buffer.slice(buffer.indexOf("\n") + 1);
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`MCP timeout: ${method}; ${stderr}`));
      }, 10000);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      processHandle.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  t.after(async () => {
    processHandle.stdin.end();
    if (processHandle.exitCode === null) {
      const timer = setTimeout(() => processHandle.kill(), 3000);
      await once(processHandle, "exit");
      clearTimeout(timer);
    }
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { send, runtime, processHandle, stderr: () => stderr };
}
const meta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "ssh-test-client", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
test("legacy MCP exposes individual annotated actions without setup, credentials or generic dispatch", async (t) => {
  const h = await harness(t);
  const initialized = await h.send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  h.processHandle.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  const listed = await h.send("tools/list");
  const names = listed.result.tools.map((t) => t.name);
  assert.deepEqual(
    names.sort(),
    Object.entries(catalog)
      .filter(([, c]) => !c.operator)
      .map(([n]) => n)
      .sort(),
  );
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    assert.equal(typeof tool.annotations.destructiveHint, "boolean");
    assert.equal(typeof tool.annotations.openWorldHint, "boolean");
  }
  for (const name of [
    "ssh_grants_set",
    "ssh_host_confirm",
    "ssh_credential_add",
    "ssh_vault_unlock",
    "execute",
    "http_request",
  ])
    assert.ok(!names.includes(name));
  const called = await h.send("tools/call", { name: "ssh_hosts_list", arguments: {} });
  assert.deepEqual(called.result.structuredContent, { data: [] });
  const host = h.runtime.manager.createProfile(
    { id: "fixture-operator", kind: "operator" },
    { name: "unapproved", host: "127.0.0.1", username: "fixture" },
  );
  for (const [name, args] of [
    ["ssh_connection_open", {}],
    ["ssh_job_start", { command: "forbidden" }],
    ["ssh_session_create", {}],
    ["ssh_file_read", { path: "/denied" }],
    ["ssh_file_write", { path: "/denied", data: "eA==" }],
    ["ssh_tunnel_create", { kind: "socks", listenPort: 0 }],
  ]) {
    const denied = await h.send("tools/call", { name, arguments: { targetId: host.id, ...args } });
    assert.equal(denied.result.isError, true);
    assert.equal(JSON.parse(denied.result.content[0].text).error.code, "FORBIDDEN");
  }
  const spoofed = await h.send("tools/call", {
    name: "ssh_hosts_list",
    arguments: { actor: { kind: "operator" } },
  });
  assert.ok(spoofed.result?.isError || spoofed.error);
  assert.equal(h.stderr(), "");
});
test("2026 discovery and per-request envelopes work in the portable bundle; client EOF leaves the daemon alive", async (t) => {
  const h = await harness(t, true);
  const discovery = await h.send("server/discover", { _meta: meta });
  assert.ok(discovery.result);
  assert.equal(discovery.error, undefined);
  const listed = await h.send("tools/list", { _meta: meta });
  assert.ok(listed.result.tools.length > 20);
  const called = await h.send("tools/call", {
    name: "ssh_vault_status",
    arguments: {},
    _meta: meta,
  });
  assert.deepEqual(called.result.structuredContent.data, {
    initialized: false,
    locked: true,
    recordCount: 0,
  });
  const exit = once(h.processHandle, "exit");
  h.processHandle.stdin.end();
  await exit;
  const live = await fetch(h.runtime.url + "/v1/clients", {
    method: "POST",
    headers: {
      authorization: `Bearer ${h.runtime.agentToken}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(live.status, 200);
  assert.equal(h.stderr(), "");
});
