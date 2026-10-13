import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import { SSHManager } from "../dist/index.js";
import {
  managedFixture,
  configuredManager,
  sshFixture,
  agent,
  password,
  allCapabilities,
  until,
} from "./fixture.mjs";

function rootFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-fixture-lifetime-")));
  const remove = fs.rmSync;
  t.after(() => remove(root, { recursive: true, force: true }));
  return { root, options: { temporaryRoot: root, ssh: { temporaryRoot: root } } };
}
// Observe the same after-hook seam without making intentionally failed cleanup fail this test.
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

test("owned fixture registers release and automatically closes its manager, transport and state", async (t) => {
  const { root, options } = rootFixture(t);
  let ctx;
  await t.test("real test lifetime", async (lifetime) => {
    ctx = await managedFixture(lifetime, options);
    assert.deepEqual(ctx.manager.grants(agent, ctx.profile.id).capabilities, allCapabilities);
    await ctx.manager.openConnection(agent, ctx.profile.id);
    assert.equal(ctx.manager.connections(agent).length, 1);
    assert.ok(fs.existsSync(ctx.directory));
  });
  assert.equal(ctx.fixture.server.address(), null);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(ctx.close(), ctx.close(), "Repeated release shares the same settled promise.");
  await ctx.close();
});

test("constructor, vault and approved-setup failures roll back counterpart and manager state", async (t) => {
  for (const stage of ["constructor", "vault", "grant"])
    await t.test(stage, async (t) => {
      const { root, options } = rootFixture(t);
      const context = registration();
      const failure = new Error(`synthetic ${stage} setup failure`);
      if (stage === "constructor") options.limits = { channels: 0 };
      else {
        const method = stage === "vault" ? "vaultInitialize" : "setGrants";
        t.mock.method(SSHManager.prototype, method, function () {
          assert.equal(context.hooks.length, 1, "Ownership is registered before manager setup.");
          throw failure;
        });
      }
      await assert.rejects(
        () => managedFixture(context, options),
        (error) =>
          stage === "constructor" ? error.code === "INVALID_ARGUMENT" : error === failure,
      );
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(context.hooks.length, 1);
      await context.hooks[0]();
      await context.hooks[0]();
    });
});

test("failure to register test ownership releases the acquired counterpart", async (t) => {
  const { root, options } = rootFixture(t);
  const failure = new Error("synthetic registration failure");
  await assert.rejects(
    () =>
      managedFixture(
        {
          after: () => {
            throw failure;
          },
        },
        options,
      ),
    (error) => error === failure,
  );
  assert.deepEqual(fs.readdirSync(root), []);
});

test("counterpart initialization and listen failures remove acquired temporary state", async (t) => {
  for (const stage of ["canonical root", "payload", "listen"])
    await t.test(stage, async (t) => {
      const { root } = rootFixture(t);
      const failure = new Error(`synthetic counterpart ${stage} failure`);
      if (stage === "canonical root") {
        t.mock.method(fs, "realpathSync", () => {
          throw failure;
        });
      } else if (stage === "payload") {
        t.mock.method(fs, "writeFileSync", () => {
          throw failure;
        });
      } else {
        t.mock.method(ssh2.Server.prototype, "listen", function () {
          process.nextTick(() => this.emit("error", failure));
          return this;
        });
      }
      await assert.rejects(
        () => sshFixture({ temporaryRoot: root }),
        (error) => error === failure,
      );
      assert.deepEqual(fs.readdirSync(root), []);
    });
});

test("cleanup reports manager and state-removal failures but still closes the counterpart", async (t) => {
  const { root, options } = rootFixture(t);
  const context = registration();
  const ctx = await managedFixture(context, options);
  await ctx.manager.openConnection(agent, ctx.profile.id);
  const shutdownFailure = new Error("synthetic shutdown failure");
  const removalFailure = new Error("synthetic state-removal failure");
  const shutdown = ctx.manager.shutdown.bind(ctx.manager);
  const shutdownMock = t.mock.method(ctx.manager, "shutdown", () => {
    shutdown();
    throw shutdownFailure;
  });
  const remove = fs.rmSync;
  t.mock.method(fs, "rmSync", (directory, config) => {
    if (directory === ctx.directory) throw removalFailure;
    return remove(directory, config);
  });
  let reported;
  const first = ctx.close();
  assert.equal(first, ctx.close());
  await assert.rejects(first, (error) => {
    reported = error;
    return containsError(error, shutdownFailure) && containsError(error, removalFailure);
  });
  assert.equal(ctx.fixture.server.address(), null);
  assert.equal(fs.existsSync(ctx.fixture.directory), false);
  assert.ok(
    fs.existsSync(ctx.directory),
    "Failed removal remains visible, not claimed successful.",
  );
  assert.equal(fs.readdirSync(root).length, 1);
  await assert.rejects(context.hooks[0](), (error) => error === reported);
  assert.equal(shutdownMock.mock.callCount(), 1, "Repeated release does not rerun shutdown.");
});

test("setup rejection retains both the primary failure and a rollback failure", async (t) => {
  const { root, options } = rootFixture(t);
  const context = registration();
  const setupFailure = new Error("synthetic trust setup failure");
  const rollbackFailure = new Error("synthetic rollback shutdown failure");
  t.mock.method(SSHManager.prototype, "confirmHost", () => {
    throw setupFailure;
  });
  const shutdown = SSHManager.prototype.shutdown;
  t.mock.method(SSHManager.prototype, "shutdown", function () {
    shutdown.call(this);
    throw rollbackFailure;
  });
  await assert.rejects(
    () => managedFixture(context, options),
    (error) => containsError(error, setupFailure) && containsError(error, rollbackFailure),
  );
  assert.deepEqual(fs.readdirSync(root), []);
  await context.hooks[0]();
});

test("counterpart release still destroys nested transport when graceful client end fails", async (t) => {
  const { root } = rootFixture(t);
  const fixture = await sshFixture({ temporaryRoot: root });
  t.after(() => fixture.close().catch(() => {})); // The asserted cleanup failure is intentionally cached.
  const client = new ssh2.Client();
  t.after(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({
      host: "127.0.0.1",
      port: fixture.port,
      username: "fixture-user",
      password,
      hostVerifier: (key) => key.equals(fixture.publicKey),
    });
  });
  const counterpart = [...fixture.connections][0];
  const failure = new Error("synthetic graceful-end failure");
  t.mock.method(counterpart, "end", () => {
    throw failure;
  });
  const transport = counterpart._sock;
  const close = fixture.close();
  assert.equal(close, fixture.close());
  await assert.rejects(close, (error) => containsError(error, failure));
  await until(() => transport.destroyed);
  assert.equal(fixture.server.address(), null);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("owned lifetime tracks a replacement manager and rejects restart after release", async (t) => {
  const { root, options } = rootFixture(t);
  const context = registration();
  const ctx = await managedFixture(context, options);
  const initial = ctx.manager;
  const replacement = ctx.restart();
  assert.notEqual(replacement, initial);
  assert.equal(ctx.manager, replacement);
  assert.equal(
    replacement.vaultStatus(agent).locked,
    true,
    "Restart does not silently unlock the vault.",
  );
  const shutdown = replacement.shutdown.bind(replacement);
  const shutdownMock = t.mock.method(replacement, "shutdown", shutdown);
  await context.hooks[0]();
  assert.equal(shutdownMock.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.throws(() => ctx.restart(), /closed/);
});

test("independently owned configured-manager close stays synchronous and leaves its counterpart running", async (t) => {
  const { root } = rootFixture(t);
  const fixture = await sshFixture({ temporaryRoot: root });
  t.after(fixture.close);
  const ctx = await configuredManager(fixture, { temporaryRoot: root });
  t.after(ctx.close);
  assert.equal(ctx.close(), undefined);
  assert.equal(ctx.close(), undefined);
  assert.equal(fs.existsSync(ctx.directory), false);
  assert.notEqual(fixture.server.address(), null);
});
