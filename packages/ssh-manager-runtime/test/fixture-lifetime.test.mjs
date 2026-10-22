import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagementClient } from "../dist/client.js";
import { runtimeFixture } from "./fixture.mjs";

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-runtime-lifetime-"));
  const remove = fs.rmSync;
  t.after(() => remove(root, { recursive: true, force: true }));
  return root;
}
function registration() {
  const hooks = [];
  return { hooks, after: (hook) => hooks.push(hook) };
}
function containsError(error, expected) {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.some((nested) => containsError(nested, expected)))
  );
}

test("runtime fixture owns authenticated clients, listener and state through the actual test lifetime", async (t) => {
  const root = temporaryRoot(t);
  let ctx;
  await t.test("owned lifetime", async (lifetime) => {
    ctx = await runtimeFixture(lifetime, { temporaryRoot: root });
    assert.equal(ctx.human.registration.kind, "operator");
    assert.equal(ctx.agent.registration.kind, "agent");
    assert.deepEqual(await ctx.agent.call("ssh_hosts_list", {}), []);
    assert.ok(ctx.runtime.app.server.listening);
    assert.ok(fs.existsSync(ctx.directory));
  });
  assert.equal(ctx.human.registration, undefined);
  assert.equal(ctx.agent.registration, undefined);
  assert.equal(ctx.runtime.app.server.address(), null);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(ctx.close(), ctx.close());
  await ctx.close();
});

test("runtime fixture rolls back failed allocation, startup and either client registration", async (t) => {
  for (const stage of ["directory", "runtime", "operator", "agent"])
    await t.test(stage, async (t) => {
      const root = temporaryRoot(t);
      const context = registration();
      const failure = new Error(`synthetic ${stage} setup failure`);
      const connect = ManagementClient.prototype.connect;
      const close = ManagementClient.prototype.close;
      let connections = 0,
        url;
      const clients = [];
      t.mock.method(ManagementClient.prototype, "connect", function (...args) {
        assert.equal(context.hooks.length, 1, "Ownership precedes asynchronous client setup.");
        url = this.url;
        if (++connections === (stage === "operator" ? 1 : stage === "agent" ? 2 : 0)) throw failure;
        return connect.apply(this, args);
      });
      t.mock.method(ManagementClient.prototype, "close", function (...args) {
        clients.push(this);
        return close.apply(this, args);
      });
      if (stage === "directory")
        t.mock.method(fs, "mkdtempSync", () => {
          assert.equal(context.hooks.length, 1);
          throw failure;
        });
      if (stage === "runtime") {
        const write = fs.writeFileSync;
        t.mock.method(fs, "writeFileSync", (file, ...args) => {
          if (path.basename(file) === "agent.token") {
            assert.equal(context.hooks.length, 1);
            throw failure;
          }
          return write(file, ...args);
        });
      }
      await assert.rejects(
        () => runtimeFixture(context, { temporaryRoot: root }),
        (e) => e === failure,
      );
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(clients.length, stage === "operator" ? 1 : stage === "agent" ? 2 : 0);
      for (const client of clients) assert.equal(client.registration, undefined);
      if (url) await assert.rejects(fetch(url), "The actual runtime listener must be closed.");
      assert.equal(context.hooks.length, 1);
      const released = context.hooks[0]();
      assert.equal(released, context.hooks[0]());
      await released;
    });
});

test("failed test-hook registration acquires no runtime fixture resources", async (t) => {
  const root = temporaryRoot(t);
  const failure = new Error("synthetic ownership registration failure");
  await assert.rejects(
    () =>
      runtimeFixture(
        {
          after() {
            throw failure;
          },
        },
        { temporaryRoot: root },
      ),
    (error) => error === failure,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("runtime fixture attempts every cleanup and caches the same combined failure", async (t) => {
  const root = temporaryRoot(t);
  const context = registration();
  const ctx = await runtimeFixture(context, { temporaryRoot: root });
  const order = [];
  const failures = ["operator", "agent", "runtime", "state"].map((name) => new Error(name));
  for (const [owner, name, failure] of [
    [ctx.human, "operator", failures[0]],
    [ctx.agent, "agent", failures[1]],
    [ctx.runtime, "runtime", failures[2]],
  ]) {
    const close = owner.close.bind(owner);
    t.mock.method(owner, "close", async () => {
      order.push(name);
      await close();
      throw failure;
    });
  }
  const remove = fs.rmSync;
  t.mock.method(fs, "rmSync", (directory, config) => {
    if (directory === ctx.directory) {
      order.push("state");
      throw failures[3];
    }
    return remove(directory, config);
  });
  let reported;
  const first = ctx.close();
  assert.equal(first, ctx.close());
  await assert.rejects(first, (error) => {
    reported = error;
    return (
      error instanceof AggregateError && failures.every((failure) => containsError(error, failure))
    );
  });
  assert.deepEqual(order, ["operator", "agent", "runtime", "state"]);
  assert.equal(ctx.runtime.app.server.address(), null);
  assert.equal(ctx.human.registration, undefined);
  assert.equal(ctx.agent.registration, undefined);
  assert.ok(fs.existsSync(ctx.directory), "Failed state removal remains visible.");
  await assert.rejects(context.hooks[0](), (error) => error === reported);
  assert.equal(order.length, 4, "Repeated close must not rerun failed cleanup.");
});

test("runtime fixture preserves setup and rollback failures together", async (t) => {
  const root = temporaryRoot(t);
  const context = registration();
  const setupFailure = new Error("synthetic agent registration failure");
  const rollbackFailure = new Error("synthetic operator cleanup failure");
  const connect = ManagementClient.prototype.connect;
  const close = ManagementClient.prototype.close;
  let connections = 0,
    cleanupFailure;
  t.mock.method(ManagementClient.prototype, "connect", function (...args) {
    if (++connections === 2) throw setupFailure;
    return connect.apply(this, args);
  });
  let closes = 0;
  t.mock.method(ManagementClient.prototype, "close", async function (...args) {
    const operator = this.registration?.kind === "operator";
    closes++;
    await close.apply(this, args);
    if (operator) throw rollbackFailure;
  });
  await assert.rejects(
    () => runtimeFixture(context, { temporaryRoot: root }),
    (error) => {
      cleanupFailure = error.errors?.[1];
      return containsError(error, setupFailure) && containsError(error, rollbackFailure);
    },
  );
  assert.equal(closes, 2, "Even the client whose registration failed remains owned.");
  assert.deepEqual(fs.readdirSync(root), []);
  await assert.rejects(context.hooks[0](), (error) => error === cleanupFailure);
  assert.equal(closes, 2);
});
