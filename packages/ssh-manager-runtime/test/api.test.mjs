import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { once } from "node:events";
import http from "node:http";
import { runtimeFixture } from "./fixture.mjs";
import { catalog } from "../dist/catalog.js";
import {
  sshFixture,
  allCapabilities,
  password,
  vaultPassword,
  until,
  delay,
} from "../../ssh-manager/test/fixture.mjs";

test("operator API stores and restores valid large vault backups while denying agents before body parsing", async (t) => {
  const { runtime, human, agent } = await runtimeFixture(t);
  await human.call("ssh_vault_initialize", { password: vaultPassword });
  const reference = await human.call("ssh_credential_add", {
    reference: { kind: "vault", name: "large backup fixture", secretKind: "passphrase" },
    secret: { value: "x".repeat(1100 * 1024) },
  });
  const document = await human.call("ssh_vault_backup", {});
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024);
  await assert.rejects(agent.call("ssh_vault_restore", { document, password: vaultPassword }), {
    code: "FORBIDDEN",
  });
  const registration = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.agentToken}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  const malformed = await fetch(runtime.url + "/v1/ssh_vault_restore", {
    method: "POST",
    headers: {
      authorization: `Bearer ${registration.data.token}`,
      "content-type": "application/json",
    },
    body: "{invalid-json",
  });
  assert.equal(
    malformed.status,
    403,
    "operator role must be checked before parsing setup payloads",
  );
  await human.call("ssh_vault_lock", {});
  await assert.rejects(
    human.call("ssh_vault_restore", { document, password: "incorrect-vault-password" }),
    {
      code: "VAULT_AUTHENTICATION",
    },
  );
  await human.call("ssh_vault_restore", { document, password: vaultPassword });
  assert.deepEqual(await human.call("ssh_vault_backup", {}), document);
  assert.ok(
    (await human.call("ssh_credentials_list", {})).some((entry) => entry.id === reference.id),
  );
});
test("loopback bearer roles, Host/Origin checks and strict inputs prevent API privilege escalation", async (t) => {
  const { runtime, human, agent } = await runtimeFixture(t);
  const unauthenticated = await fetch(runtime.url + "/v1/ssh_hosts_list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.operatorToken}`,
      "content-type": "application/json",
      origin: "https://untrusted.example.test",
    },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  const spoofedHost = await new Promise((resolve) => {
    const req = http.request(
      runtime.url + "/v1/clients",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.operatorToken}`,
          "content-type": "application/json",
          host: "untrusted.example.test",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.end("{}");
  });
  assert.equal(spoofedHost, 403);
  const spoofedRole = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.agentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "operator" }),
  });
  assert.equal(spoofedRole.status, 400);
  await assert.rejects(agent.call("ssh_vault_initialize", { password: vaultPassword }), {
    code: "FORBIDDEN",
  });
  const profile = await human.call("ssh_host_create", {
    profile: { name: "unapproved", host: "127.0.0.1", username: "test" },
  });
  const denied = [
    ["ssh_connection_open", { targetId: profile.id }],
    ["ssh_job_start", { targetId: profile.id, command: "test" }],
    ["ssh_session_create", { targetId: profile.id }],
    ["ssh_files_list", { targetId: profile.id, path: "/" }],
    ["ssh_file_write", { targetId: profile.id, path: "/x", data: "eA==" }],
    ["ssh_tunnel_create", { targetId: profile.id, kind: "socks", listenPort: 0 }],
    [
      "ssh_grants_set",
      { targetId: profile.id, expectedRevision: 1, capabilities: allCapabilities },
    ],
    ["ssh_host_confirm", { targetId: profile.id, expectedRevision: 1, key: "x", fingerprint: "x" }],
  ];
  for (const [name, args] of denied)
    await assert.rejects(agent.call(name, args), { code: "FORBIDDEN" });
  const response = await fetch(runtime.url + "/v1/openapi.json", {
    headers: { authorization: `Bearer ${runtime.agentToken}` },
  });
  assert.equal(response.status, 401, "bootstrap tokens cannot invoke operations");
  const registered = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.agentToken}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  const openapi = await fetch(runtime.url + "/v1/openapi.json", {
    headers: { authorization: `Bearer ${registered.data.token}` },
  }).then((r) => r.json());
  assert.equal(openapi.openapi, "3.1.0");
  for (const name of Object.keys(catalog)) assert.ok(openapi.paths[`/v1/${name}`]);
});
test("HTTP streaming and WebSocket use the same target permissions and authenticated writer", async (t) => {
  const fixture = await sshFixture();
  t.after(() => fixture.close());
  const { runtime, human, agent } = await runtimeFixture(t);
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
      fileRoots: ["/allowed"],
    },
  });
  const inspected = await human.call("ssh_host_inspect", { targetId: profile.id });
  assert.equal(inspected.fingerprint, fixture.fingerprint);
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
  const upload = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("streamed data"));
      controller.close();
    },
  });
  await agent.upload(profile.id, "/allowed/api-upload.txt", upload);
  const download = await agent.download(profile.id, "/allowed/api-upload.txt");
  assert.equal(await new Response(download).text(), "streamed data");
  const session = await agent.call("ssh_session_create", { targetId: profile.id });
  const registered = await fetch(runtime.url + "/v1/clients", {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.agentToken}`, "content-type": "application/json" },
    body: "{}",
  }).then((r) => r.json());
  const ws = new WebSocket(runtime.url.replace(/^http/, "ws") + "/v1/events", {
    origin: runtime.url,
  });
  await once(ws, "open");
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  ws.send(JSON.stringify({ token: registered.data.token, sessionId: session.id }));
  await until(() => messages.some((m) => m.type === "attached"));
  ws.send(JSON.stringify({ type: "input", data: "unauthorized" }));
  await until(() => messages.some((m) => m.error?.code === "WRITER_REQUIRED"));
  ws.send(JSON.stringify({ type: "writer" }));
  await until(() => messages.some((m) => m.type === "accepted" && m.data.writer));
  ws.send(JSON.stringify({ type: "input", data: "websocket\r" }));
  await until(async () =>
    (await agent.call("ssh_session_read", { sessionId: session.id })).output.parts.some((p) =>
      p.text.includes("websocket"),
    ),
  );
  ws.close();
  await once(ws, "close");
  assert.equal(
    (await agent.call("ssh_session_read", { sessionId: session.id })).session.state,
    "running",
  );
  await human.call("ssh_grants_set", {
    targetId: profile.id,
    expectedRevision: 1,
    capabilities: ["connect"],
  });
  await assert.rejects(agent.download(profile.id, "/allowed/api-upload.txt"), {
    code: "FORBIDDEN",
  });
  assert.ok(!JSON.stringify(await agent.call("ssh_audit_read", {})).includes(password));
});
