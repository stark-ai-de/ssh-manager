import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SSHManager } from "../dist/index.js";

const actor = { id: "vault-compatibility-fixture", kind: "operator" };
const originalPassword = "isolated native vault 🔐";
const nextPassword = "isolated wasm rotation 🔑";

function fallbackProcess(directory, code, operation) {
  // Patch only this child before loading the canonical public API. No production test hook.
  const program = `
    import crypto from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    crypto.argon2 = (_algorithm, _options, callback) => callback(Object.assign(new Error('fixture capability result'), {code: ${JSON.stringify(code)}}));
    syncBuiltinESMExports();
    const { SSHManager } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
    const manager = new SSHManager({stateDirectory: ${JSON.stringify(directory)},knownHosts:[]});
    const actor = ${JSON.stringify(actor)};
    try { ${operation} } finally { manager.shutdown(); }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
    encoding: "utf8",
    timeout: 20000,
  });
}

test("WASM Argon2id opens a native vault, rotates without changing format and remains native-readable", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-vault-argon2-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let manager = new SSHManager({ stateDirectory: directory, knownHosts: [] });
  try {
    await manager.vaultInitialize(actor, originalPassword);
    manager.addCredential(
      actor,
      { kind: "vault", name: "fixture", secretKind: "password" },
      { value: "isolated stored secret" },
    );
    const before = manager.vaultBackup(actor);
    manager.shutdown();
    const child = fallbackProcess(
      directory,
      "ERR_CRYPTO_ARGON2_NOT_SUPPORTED",
      `
      await manager.vaultUnlock(actor, ${JSON.stringify(originalPassword)});
      assert.equal(manager.vaultStatus(actor).recordCount, 1);
      await manager.vaultRotate(actor, ${JSON.stringify(originalPassword)}, ${JSON.stringify(nextPassword)});
      manager.vaultLock(actor);
      await assert.rejects(manager.vaultUnlock(actor, 'incorrect-fixture-password'));
      await manager.vaultUnlock(actor, ${JSON.stringify(nextPassword)});
      assert.equal(manager.vaultStatus(actor).locked, false);
    `,
    );
    assert.equal(child.status, 0, child.stderr);
    manager = new SSHManager({ stateDirectory: directory, knownHosts: [] });
    await manager.vaultUnlock(actor, nextPassword);
    const after = manager.vaultBackup(actor);
    assert.equal(after.schema, before.schema);
    assert.deepEqual({ ...after.kdf, salt: before.kdf.salt }, before.kdf);
    assert.deepEqual(after.records, before.records);
    assert.equal(manager.vaultStatus(actor).recordCount, 1);
  } finally {
    manager.shutdown();
  }
});

test("unrelated native KDF errors do not select another backend or mutate the vault", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-vault-kdf-error-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new SSHManager({ stateDirectory: directory, knownHosts: [] });
  await manager.vaultInitialize(actor, originalPassword);
  manager.shutdown();
  const before = fs.readFileSync(path.join(directory, "vault.json"));
  const child = fallbackProcess(
    directory,
    "ERR_FIXTURE_KDF_FAILURE",
    `
    await assert.rejects(manager.vaultUnlock(actor, ${JSON.stringify(originalPassword)}),{code:'ERR_FIXTURE_KDF_FAILURE'});
    assert.equal(manager.vaultStatus(actor).locked,true);
  `,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(fs.readFileSync(path.join(directory, "vault.json")), before);
});
