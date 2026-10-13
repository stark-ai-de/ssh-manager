import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { ManagementClient } from "../dist/client.js";
import {
  sshFixture,
  operator,
  password,
  vaultPassword,
  allCapabilities,
  until,
} from "../../ssh-manager/test/fixture.mjs";

test("bundled MCP starts an independent daemon; CLI reuses it and client EOF preserves a live PTY", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-daemon-contract-"));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const cli = (...args) =>
    promisify(execFile)(
      process.execPath,
      [path.join(root, "dist/ssh-runtime/cli.mjs"), ...args, "--state-directory", directory],
      { timeout: 15000 },
    );
  const fixture = await sshFixture();
  let operatorClient, agentClient, child;
  t.after(async () => {
    child?.kill();
    await agentClient?.close();
    if (operatorClient) {
      await operatorClient.stopRuntime();
      await operatorClient.close();
      await until(() => !fs.existsSync(path.join(directory, "runtime.json")));
    } else if (fs.existsSync(path.join(directory, "runtime.json")))
      process.kill(
        JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"))).pid,
        "SIGTERM",
      );
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  child = spawn(
    process.execPath,
    [path.join(root, "dist/ssh-runtime/mcp.mjs"), "--state-directory", directory],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (data) => {
    diagnostic += data;
  });
  await until(
    () =>
      fs.existsSync(path.join(directory, "runtime.json")) ||
      (child.exitCode !== null && assert.fail(diagnostic)),
    15000,
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "runtime.json")));
  assert.notEqual(metadata.pid, child.pid);
  operatorClient = await new ManagementClient(
    metadata.url,
    fs.readFileSync(path.join(directory, "operator.token"), "utf8"),
  ).connect();
  agentClient = await new ManagementClient(
    metadata.url,
    fs.readFileSync(path.join(directory, "agent.token"), "utf8"),
  ).connect();
  await operatorClient.call("ssh_vault_initialize", { password: vaultPassword });
  const credential = await operatorClient.call("ssh_credential_add", {
    reference: { kind: "vault", name: "fixture", secretKind: "password" },
    secret: { value: password },
  });
  const profile = await operatorClient.call("ssh_host_create", {
    profile: {
      name: "fixture",
      host: "127.0.0.1",
      port: fixture.port,
      username: "fixture",
      credentialId: credential.id,
    },
  });
  await operatorClient.call("ssh_host_confirm", {
    targetId: profile.id,
    expectedRevision: 1,
    key: fixture.publicKey.toString("base64"),
    fingerprint: fixture.fingerprint,
  });
  await operatorClient.call("ssh_grants_set", {
    targetId: profile.id,
    expectedRevision: 1,
    capabilities: allCapabilities,
  });
  const terminal = await agentClient.call("ssh_session_create", { targetId: profile.id });
  child.stdin.end();
  await until(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, diagnostic);
  assert.equal(
    (await agentClient.call("ssh_session_read", { sessionId: terminal.id })).session.state,
    "running",
  );
  assert.equal((await fetch(metadata.url)).status, 200);
  const started = await cli("start");
  assert.equal(JSON.parse(started.stdout).url, metadata.url);
  assert.equal(started.stderr, "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "runtime.json"))).pid, metadata.pid);
  const locked = await cli("vault-lock");
  const status = await operatorClient.call("ssh_vault_status", {});
  assert.equal(status.locked, true);
  assert.equal(locked.stdout, JSON.stringify(status) + "\n");
  assert.equal(locked.stderr, "");
  const input = path.join(directory, "cli-input.json");
  fs.writeFileSync(input, "{}");
  const inspected = await cli("operator", "ssh_vault_status", input);
  assert.equal(inspected.stdout, JSON.stringify(status, null, 2) + "\n");
  assert.equal(inspected.stderr, "");
  for (const command of ["vault-init", "vault-unlock", "vault-rotate"])
    await assert.rejects(cli(command), {
      code: 1,
      stdout: "",
      stderr: "Local setup failed. Check the operation, argument file and interactive terminal.\n",
    });
});
