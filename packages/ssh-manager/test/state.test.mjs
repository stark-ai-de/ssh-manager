import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SSHManager } from "../dist/index.js";
import { operator, agent, managedFixture } from "./fixture.mjs";

test("supported metadata migration preserves rollback bytes and unsupported versions are untouched", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-state-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  const legacy = JSON.stringify({ schema: 0, revision: 0, hosts: [], credentials: [] });
  fs.writeFileSync(file, legacy);
  const manager = new SSHManager({ stateDirectory: directory, knownHosts: [] });
  manager.createProfile(agent, { name: "new", host: "example.test", username: "fixture" });
  manager.shutdown();
  assert.equal(fs.readFileSync(path.join(directory, "state.before-v1.json"), "utf8"), legacy);
  assert.equal(JSON.parse(fs.readFileSync(file)).schema, 1);
  const future = JSON.stringify({ schema: 100, private: "must remain intact" });
  fs.writeFileSync(file, future);
  assert.throws(() => new SSHManager({ stateDirectory: directory }), { code: "STATE_VERSION" });
  assert.equal(fs.readFileSync(file, "utf8"), future);
  assert.ok(!fs.existsSync(path.join(directory, "owner.json")));
});
test("corrupt persisted PTY dimensions and concurrent state owners are rejected before allocating terminals", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-state-limit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new SSHManager({ stateDirectory: directory });
  assert.throws(() => new SSHManager({ stateDirectory: directory }), { code: "STATE_BUSY" });
  manager.createProfile(agent, { name: "fixture", host: "example.test", username: "fixture" });
  manager.shutdown();
  const file = path.join(directory, "state.json"),
    data = JSON.parse(fs.readFileSync(file));
  data.sessions = [
    {
      id: "bad",
      targetId: data.profiles[0].id,
      cols: 2147483647,
      rows: 2147483647,
      state: "running",
      tmux: false,
      recording: false,
      createdAt: "fixture",
    },
  ];
  fs.writeFileSync(file, JSON.stringify(data));
  assert.throws(() => new SSHManager({ stateDirectory: directory }), { code: "STATE_CORRUPT" });
  assert.ok(!fs.existsSync(path.join(directory, "owner.json")));
});
test("credential revisions invalidate granted targets without leaking updated secrets", async (t) => {
  const ctx = await managedFixture(t);
  await ctx.manager.openConnection(agent, ctx.profile.id);
  assert.throws(
    () =>
      ctx.manager.updateCredential(
        agent,
        ctx.credential.id,
        1,
        { kind: "vault", secretKind: "password", name: "changed" },
        { value: "replacement" },
      ),
    { code: "FORBIDDEN" },
  );
  ctx.manager.updateCredential(
    operator,
    ctx.credential.id,
    1,
    { kind: "vault", secretKind: "password", name: "changed" },
    { value: "replacement" },
  );
  assert.equal(ctx.manager.connections(agent).length, 0);
  await assert.rejects(ctx.manager.openConnection(agent, ctx.profile.id), { code: "FORBIDDEN" });
  assert.throws(
    () =>
      ctx.manager.updateCredential(operator, ctx.credential.id, 1, {
        kind: "vault",
        secretKind: "password",
        name: "stale",
      }),
    { code: "CONFLICT" },
  );
  assert.ok(!JSON.stringify(ctx.manager.audit(agent)).includes("replacement"));
});
