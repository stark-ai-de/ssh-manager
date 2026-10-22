import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { createRuntime } from "../dist/server.js";
import { ManagementClient } from "../dist/client.js";
import {
  sshFixture,
  allCapabilities,
  password,
  vaultPassword,
  until,
} from "../../ssh-manager/test/fixture.mjs";

const ttl = 2000;

async function liveSession(t) {
  const fixture = await sshFixture();
  t.after(() => fixture.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-lifecycle-test-"));
  const runtime = await createRuntime({
    stateDirectory: directory,
    knownHosts: [],
    clientTtlMs: ttl,
    limits: { authTimeout: 1500, channelTimeout: 1500 },
  });
  const human = await new ManagementClient(runtime.url, runtime.operatorToken).connect();
  const agent = await new ManagementClient(runtime.url, runtime.agentToken).connect();
  const keepAlive = setInterval(() => {
    void human.heartbeat().catch(() => {});
    void agent.heartbeat().catch(() => {});
  }, 250);
  t.after(async () => {
    clearInterval(keepAlive);
    await human.close();
    await agent.close();
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await human.call("ssh_vault_initialize", { password: vaultPassword });
  const credential = await human.call("ssh_credential_add", {
    reference: { name: "fixture", kind: "vault", secretKind: "password" },
    secret: { value: password },
  });
  const profile = await human.call("ssh_host_create", {
    profile: {
      name: "fixture",
      host: "127.0.0.1",
      port: fixture.port,
      username: "fixture-user",
      credentialId: credential.id,
    },
  });
  const inspected = await human.call("ssh_host_inspect", { targetId: profile.id });
  await human.call("ssh_host_confirm", {
    targetId: profile.id,
    expectedRevision: 1,
    key: inspected.key,
    fingerprint: inspected.fingerprint,
  });
  await human.call("ssh_grants_set", {
    targetId: profile.id,
    expectedRevision: 1,
    capabilities: allCapabilities,
  });
  const session = await agent.call("ssh_session_create", { targetId: profile.id });
  return { fixture, runtime, agent, session };
}

async function register(runtime) {
  const reply = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.agentToken}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  return reply.data.token;
}

async function viewer(runtime, token, sessionId) {
  const ws = new WebSocket(runtime.url.replace(/^http/, "ws") + "/v1/events", {
    origin: runtime.url,
  });
  await once(ws, "open");
  const messages = [];
  let closed;
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  ws.once("close", (code) => (closed = { code }));
  ws.send(JSON.stringify({ token, sessionId }));
  await until(() => messages.some((m) => m.type === "attached"));
  return { ws, closed: () => closed };
}

const heartbeat = (runtime, token) =>
  fetch(runtime.url + "/v1/clients/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });

test("session output does not extend a silent viewer client; expiry closes its socket", async (t) => {
  const { fixture, runtime, agent, session } = await liveSession(t);
  const token = await register(runtime);
  const watched = await viewer(runtime, token, session.id);
  const output = setInterval(() => {
    for (const channel of fixture.shells) channel.write("tick\r\n");
  }, 100);
  t.after(() => clearInterval(output));
  await until(() => watched.closed(), ttl * 4);
  clearInterval(output);
  assert.equal(watched.closed().code, 1008);
  assert.equal((await heartbeat(runtime, token)).status, 401);
  assert.equal(
    (await agent.call("ssh_session_read", { sessionId: session.id })).session.state,
    "running",
  );
});

test("detaching a client closes its idle viewer socket and keeps the session", async (t) => {
  const { runtime, agent, session } = await liveSession(t);
  const token = await register(runtime);
  const watched = await viewer(runtime, token, session.id);
  const detached = await fetch(runtime.url + "/v1/clients/detach", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  assert.equal(detached.data.detached, true);
  await until(() => watched.closed(), 1000);
  assert.equal(watched.closed().code, 1008);
  assert.equal(
    (await agent.call("ssh_session_read", { sessionId: session.id })).session.state,
    "running",
  );
});

test("invalid close options are rejected before close latches, so detach still happens", async (t) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/clients"
          ? {
              data: {
                token: "t".repeat(43),
                actor: { id: "close-actor", kind: "agent" },
                expiresInMs: 120000,
              },
            }
          : { data: { detached: true } },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const options of [
    { timeout: Number.NaN },
    { timeout: 0 },
    { timeout: -1 },
    { timeout: 1.5 },
    { timeout: Number.POSITIVE_INFINITY },
    { timeout: 2 ** 31 },
    { capacityClass: "bulk" },
  ]) {
    for (const strictCleanup of [false, true]) {
      requests.length = 0;
      const client = await new ManagementClient(url, "bootstrap", {
        automaticHeartbeat: false,
        strictCleanup,
      }).connect();
      await assert.rejects(client.close(options), { code: "INVALID_ARGUMENT" });
      assert.ok(client.registration, "invalid options must not latch close");
      await client.close();
      assert.deepEqual(requests, ["/v1/clients", "/v1/clients/detach"]);
      assert.equal(client.registration, undefined);
    }
  }
});
