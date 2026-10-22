import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { managedFixture, agent, operator, profileInput, allCapabilities } from "./fixture.mjs";

test(
  "a narrowed file operation denies a symlink into another allowed target root",
  { skip: process.platform === "win32" },
  async (t) => {
    const ctx = await managedFixture(t);
    fs.mkdirSync(path.join(ctx.fixture.directory, "other-workspace"));
    fs.writeFileSync(
      path.join(ctx.fixture.directory, "other-workspace", "private.txt"),
      "other-root",
    );
    fs.symlinkSync("../other-workspace", path.join(ctx.fixture.directory, "allowed", "cross-root"));
    const profile = ctx.manager.updateProfile(operator, ctx.profile.id, ctx.profile.revision, {
      ...profileInput(ctx.profile),
      fileRoots: ["/allowed", "/other-workspace"],
    });
    ctx.manager.confirmHost(
      operator,
      profile.id,
      profile.revision,
      ctx.fixture.publicKey.toString("base64"),
      ctx.fixture.fingerprint,
    );
    ctx.manager.setGrants(operator, profile.id, profile.revision, allCapabilities);
    const remote = "/allowed/cross-root/private.txt";
    const ordinary = await ctx.manager.files.read(agent, profile.id, remote);
    assert.equal(Buffer.from(ordinary.data, "base64").toString(), "other-root");
    const scope = { roots: ["/allowed"] };
    const files = ctx.manager.files;
    const denied = [
      () => files.read(agent, profile.id, remote, 0, 65536, undefined, scope),
      () => files.list(agent, profile.id, "/allowed/cross-root", undefined, scope),
      () => files.stat(agent, profile.id, remote, undefined, scope),
      () => files.download(agent, profile.id, remote, { scope }),
      () =>
        files.upload(agent, profile.id, "/allowed/cross-root/new.txt", Readable.from("no"), {
          scope,
        }),
      () => files.mutate(agent, profile.id, "mkdir", "/allowed/cross-root/new-dir", { scope }),
      () => files.mutate(agent, profile.id, "remove", remote, { scope }),
      () => files.mutate(agent, profile.id, "chmod", remote, { mode: 0o777, scope }),
      () =>
        files.mutate(agent, profile.id, "rename", remote, {
          destination: "/allowed/moved.txt",
          scope,
        }),
      () =>
        files.mutate(agent, profile.id, "rename", "/allowed/hello.txt", {
          destination: "/allowed/cross-root/moved.txt",
          scope,
        }),
    ];
    for (const operation of denied) await assert.rejects(operation(), { code: "PATH_DENIED" });
    assert.equal(
      fs.readFileSync(path.join(ctx.fixture.directory, "other-workspace", "private.txt"), "utf8"),
      "other-root",
    );
    assert.deepEqual(fs.readdirSync(path.join(ctx.fixture.directory, "other-workspace")), [
      "private.txt",
    ]);
    assert.ok(fs.existsSync(path.join(ctx.fixture.directory, "allowed", "hello.txt")));
  },
);

test("file scopes cannot expand grants or profile roots and empty scopes deny access", async (t) => {
  const ctx = await managedFixture(t);
  const files = ctx.manager.files;
  const scope = { roots: ["/allowed"] };
  const created = await files.upload(
    agent,
    ctx.profile.id,
    "/allowed/scoped.txt",
    Readable.from("scoped-content"),
    { scope },
  );
  assert.equal(created.completed, true);
  const content = await files.read(
    agent,
    ctx.profile.id,
    "/allowed/scoped.txt",
    0,
    65536,
    undefined,
    scope,
  );
  assert.equal(Buffer.from(content.data, "base64").toString(), "scoped-content");
  await files.mutate(agent, ctx.profile.id, "rename", "/allowed/scoped.txt", {
    destination: "/allowed/renamed.txt",
    scope,
  });
  assert.equal(
    (await files.stat(agent, ctx.profile.id, "/allowed/renamed.txt", undefined, scope)).file,
    true,
  );
  await assert.rejects(files.list(agent, ctx.profile.id, "/allowed", undefined, { roots: [] }), {
    code: "PATH_DENIED",
  });
  await assert.rejects(files.stat(agent, ctx.profile.id, "/outside", undefined, { roots: ["/"] }), {
    code: "PATH_DENIED",
  });
  ctx.manager.setGrants(operator, ctx.profile.id, ctx.profile.revision, ["connect"]);
  await assert.rejects(files.list(agent, ctx.profile.id, "/allowed", undefined, scope), {
    code: "FORBIDDEN",
  });
});

test("file scopes reject malformed roots before authentication and snapshot caller-owned arrays", async (t) => {
  const ctx = await managedFixture(t, { ssh: { authDelay: 100 } });
  const invalid = [
    null,
    {},
    { roots: ["relative"] },
    { roots: ["/allowed/../outside"] },
    { roots: ["/allowed/"] },
    { roots: ["/allowed\u007f"] },
    { roots: ["/allowed\\bad"] },
    { roots: ["/allowed"], extra: true },
    { roots: Array(17).fill("/allowed") },
  ];
  for (const scope of invalid) {
    await assert.rejects(
      ctx.manager.files.list(agent, ctx.profile.id, "/allowed", undefined, scope),
      { code: "INVALID_ARGUMENT" },
      JSON.stringify(scope),
    );
  }
  assert.equal(ctx.fixture.counts.auth, 0);
  const roots = [];
  const pending = ctx.manager.files.list(agent, ctx.profile.id, "/allowed", undefined, { roots });
  roots.push("/allowed");
  await assert.rejects(pending, { code: "PATH_DENIED" });
});

test(
  "creation refuses a dangling leaf symlink even when the parent is allowed",
  { skip: process.platform === "win32" },
  async (t) => {
    const ctx = await managedFixture(t);
    const outside = path.join(ctx.fixture.directory, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync("../outside/new.txt", path.join(ctx.fixture.directory, "allowed", "dangling"));
    await assert.rejects(
      ctx.manager.files.upload(
        agent,
        ctx.profile.id,
        "/allowed/dangling",
        Readable.from("must-not-write"),
      ),
      { code: "PATH_DENIED" },
    );
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  },
);
