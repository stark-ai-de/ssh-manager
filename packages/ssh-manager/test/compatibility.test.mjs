import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SSHManager } from "../dist/index.js";
import {
  agent,
  allCapabilities,
  managedFixture,
  operator,
  password,
  profileInput,
  until,
} from "./fixture.mjs";

function preview(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-import-preview-"));
  const manager = new SSHManager({ stateDirectory: directory, knownHosts: [] });
  t.after(() => {
    manager.shutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return manager.previewImport(operator, text);
}

test("import preview keeps Match directives out of the preceding Host block", (t) => {
  const result = preview(
    t,
    [
      "Host alpha",
      "  HostName alpha.example",
      "Match host beta",
      "  User intruder",
      "  HostName elsewhere.example",
      "Host gamma",
      "  User g",
    ].join("\n"),
  );
  assert.deepEqual(result.profiles, [
    { name: "alpha", host: "alpha.example", username: "", port: 22 },
    { name: "gamma", host: "gamma", username: "g", port: 22 },
  ]);
  assert.deepEqual(result.warnings, [
    { line: 3, directive: "match" },
    { line: 4, directive: "user" },
    { line: 5, directive: "hostname" },
  ]);
});

test("import preview accepts OpenSSH key = value spacing", (t) => {
  const result = preview(
    t,
    "Host = delta\n  HostName = delta.example\n  Port=2222\n  User  =  d # note\n",
  );
  assert.deepEqual(result.profiles, [
    { name: "delta", host: "delta.example", username: "d", port: 2222 },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("import preview warnings stay bounded, explicit and tied to their Host line", (t) => {
  const many = preview(
    t,
    ["Host x", ...Array.from({ length: 300 }, () => "  ServerAliveInterval 30")].join("\n"),
  );
  assert.equal(many.warnings.length, 256);
  assert.deepEqual(many.warnings[0], { line: 2, directive: "serveraliveinterval" });
  assert.deepEqual(many.warnings.at(-1), { line: 0, directive: "warnings-truncated" });
  const result = preview(
    t,
    `${"A".repeat(100)} yes\n\nHost key\n  IdentityFile ~/.ssh/id\n  ProxyJump bastion\n`,
  );
  assert.deepEqual(result.warnings, [
    { line: 1, directive: "unknown-directive" },
    { line: 3, directive: "identityfile-requires-explicit-credential-reference" },
    { line: 3, directive: "proxyjump-requires-explicit-target-ids" },
  ]);
});

const hidden = { prompt: "Password: ", echo: false };

test("a vault password answers one hidden keyboard-interactive prompt", async (t) => {
  const ctx = await managedFixture(t, { ssh: { keyboard: [[hidden]] } });
  await ctx.manager.openConnection(agent, ctx.profile.id);
  assert.deepEqual(ctx.fixture.keyboardAnswers, [[password]]);
});

test("keyboard-interactive never offers the password to other prompts or twice", async (t) => {
  const challenge = await managedFixture(t, {
    ssh: { keyboard: [[{ prompt: "Verification code: ", echo: true }, hidden]] },
  });
  await assert.rejects(challenge.manager.openConnection(agent, challenge.profile.id), {
    code: "AUTHENTICATION_FAILED",
  });
  assert.deepEqual(challenge.fixture.keyboardAnswers, [[]]);
  const repeated = await managedFixture(t, { ssh: { keyboard: [[hidden], [hidden]] } });
  await assert.rejects(repeated.manager.openConnection(agent, repeated.profile.id), {
    code: "AUTHENTICATION_FAILED",
  });
  assert.deepEqual(repeated.fixture.keyboardAnswers, [[password], []]);
});

function useShell(ctx, shell) {
  const { manager, fixture, profile } = ctx;
  const current = manager.profiles(operator).find((p) => p.id === profile.id);
  const changed = manager.updateProfile(operator, profile.id, current.revision, {
    ...profileInput(current),
    shell,
  });
  manager.confirmHost(
    operator,
    profile.id,
    changed.revision,
    fixture.publicKey.toString("base64"),
    fixture.fingerprint,
  );
  manager.setGrants(operator, profile.id, changed.revision, allCapabilities);
}
async function jobText(manager, targetId, command) {
  const job = await manager.jobs.start(agent, targetId, command);
  await until(() => manager.jobs.read(agent, job.id).job.state !== "running");
  return manager.jobs
    .read(agent, job.id)
    .output.parts.map((p) => p.text)
    .join("");
}

test("Windows shells receive exact job commands and interactive launchers", async (t) => {
  const ctx = await managedFixture(t);
  const command = `Write-Output "größe 'x'" ; exit 0`;
  useShell(ctx, "powershell");
  const prefix = "result:powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ";
  const encoded = await jobText(ctx.manager, ctx.profile.id, command);
  assert.ok(encoded.startsWith(prefix));
  assert.equal(
    Buffer.from(encoded.slice(prefix.length).trim(), "base64").toString("utf16le"),
    command,
  );
  await ctx.manager.sessions.create(agent, ctx.profile.id);
  assert.equal(ctx.fixture.commands.at(-1), "powershell.exe -NoLogo -NoProfile");
  useShell(ctx, "cmd");
  assert.equal(
    await jobText(ctx.manager, ctx.profile.id, 'echo "a b" & ver'),
    'result:cmd.exe /d /s /c "echo ""a b"" & ver"\n',
  );
  await ctx.manager.sessions.create(agent, ctx.profile.id);
  assert.equal(ctx.fixture.commands.at(-1), "cmd.exe /d");
  assert.equal(ctx.fixture.counts.shell, 0);
});
