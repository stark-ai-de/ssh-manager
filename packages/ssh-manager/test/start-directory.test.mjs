import test from "node:test";
import assert from "node:assert/strict";
import { managedFixture, operator, agent, profileInput } from "./fixture.mjs";

test("operator can explicitly discover only the SFTP start path without granting file access", async (t) => {
  const { manager, profile } = await managedFixture(t, {
    ssh: { sftpStartDirectory: "/allowed" },
  });
  manager.setGrants(operator, profile.id, profile.revision, ["connect"]);
  assert.deepEqual(await manager.files.startDirectory(operator, profile.id), { path: "/allowed" });
  await assert.rejects(manager.files.startDirectory(agent, profile.id), { code: "FORBIDDEN" });
  await assert.rejects(manager.files.list(operator, profile.id, "/allowed"), { code: "FORBIDDEN" });
  assert.deepEqual(manager.grants(operator, profile.id).capabilities, ["connect"]);
  manager.setGrants(operator, profile.id, profile.revision, []);
  await assert.rejects(manager.files.startDirectory(operator, profile.id), { code: "FORBIDDEN" });
});

test("an explicitly empty root set permits path discovery while all file paths remain denied", async (t) => {
  const { manager, profile, fixture } = await managedFixture(t, {
    ssh: { sftpStartDirectory: "/allowed" },
  });
  const restricted = manager.updateProfile(operator, profile.id, profile.revision, {
    ...profileInput(profile),
    fileRoots: [],
  });
  manager.confirmHost(
    operator,
    restricted.id,
    restricted.revision,
    fixture.publicKey.toString("base64"),
    fixture.fingerprint,
  );
  manager.setGrants(operator, restricted.id, restricted.revision, [
    "connect",
    "files.read",
    "files.write",
  ]);
  assert.deepEqual(manager.profiles(operator)[0].fileRoots, []);
  assert.deepEqual(await manager.files.startDirectory(operator, restricted.id), {
    path: "/allowed",
  });
  await assert.rejects(manager.files.list(operator, restricted.id, "/allowed"), {
    code: "PATH_DENIED",
  });
  await assert.rejects(manager.files.stat(operator, restricted.id, "/allowed/hello.txt"), {
    code: "PATH_DENIED",
  });
  await assert.rejects(manager.files.mutate(operator, restricted.id, "mkdir", "/new-root"), {
    code: "PATH_DENIED",
  });
});

test("directory discovery rejects noncanonical server paths without granting access", async (t) => {
  for (const path of ["relative", "/allowed/../outside", "/allowed\\outside", "/allowed\u007f"]) {
    await t.test(JSON.stringify(path), async (t) => {
      const { manager, profile } = await managedFixture(t, { ssh: { sftpStartReply: path } });
      await assert.rejects(manager.files.startDirectory(operator, profile.id), {
        code: "PATH_DENIED",
      });
    });
  }
});

test("directory discovery honors cancellation and channel deadlines", async (t) => {
  const { manager, profile } = await managedFixture(t, {
    ssh: { hangStartDirectory: true },
    limits: { channelTimeout: 100 },
  });
  await assert.rejects(manager.files.startDirectory(operator, profile.id, AbortSignal.abort()), {
    code: "CANCELLED",
  });
  await assert.rejects(manager.files.startDirectory(operator, profile.id), { code: "TIMEOUT" });
});

test("a revoke or target change during discovery cannot return a stale path", async (t) => {
  for (const change of ["revoke", "revision"]) {
    await t.test(change, async (t) => {
      let invalidate;
      const { manager, profile } = await managedFixture(t, {
        ssh: { onStartDirectory: () => invalidate() },
        limits: { channelTimeout: 150 },
      });
      invalidate = () => {
        if (change === "revoke") manager.setGrants(operator, profile.id, profile.revision, []);
        else {
          const next = manager.updateProfile(operator, profile.id, profile.revision, {
            ...profileInput(profile),
            username: "changed-user",
          });
          manager.setGrants(operator, profile.id, next.revision, ["connect"]);
        }
      };
      await assert.rejects(manager.files.startDirectory(operator, profile.id));
    });
  }
});
