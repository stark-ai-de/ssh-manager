import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { managedFixture, operator, profileInput } from "./fixture.mjs";

const passphrase = "owned-test-encrypted-key-passphrase";
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicOnly =
  "ssh-rsa " +
  ssh2.utils
    .parseKey(keyPair.privateKey.export({ type: "pkcs1", format: "pem" }))
    .getPublicSSH()
    .toString("base64");
const encrypted = keyPair.privateKey
  .export({
    type: "pkcs1",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase,
  })
  .toString();

for (const kind of ["key-file", "vault"]) {
  for (const invalid of ["wrong-passphrase", "missing-passphrase", "malformed-key", "public-key"]) {
    test(`${kind} ${invalid} fails with a fixed credential error before SSH authentication`, async (t) => {
      const { manager, profile, fixture, directory } = await managedFixture(t, {
        limits: { authTimeout: 250 },
      });
      const key =
        invalid === "malformed-key"
          ? "owned-malformed-private-key"
          : invalid === "public-key"
            ? publicOnly
            : encrypted;
      const phrase =
        invalid === "wrong-passphrase"
          ? manager.addCredential(
              operator,
              { kind: "vault", name: "wrong phrase", secretKind: "passphrase" },
              { value: "owned-wrong-passphrase" },
            )
          : undefined;
      let credential;
      if (kind === "key-file") {
        const file = path.join(directory, "owned-key.pem");
        fs.writeFileSync(file, key, { mode: 0o600 });
        credential = manager.addCredential(operator, {
          kind,
          name: "invalid file key",
          path: file,
          ...(phrase ? { passphraseId: phrase.id } : {}),
        });
      } else
        credential = manager.addCredential(
          operator,
          {
            kind,
            name: "invalid vault key",
            secretKind: "private-key",
            ...(phrase ? { passphraseId: phrase.id } : {}),
          },
          { value: key },
        );
      const changed = manager.updateProfile(operator, profile.id, profile.revision, {
        ...profileInput(profile),
        credentialId: credential.id,
      });
      manager.setGrants(operator, changed.id, changed.revision, ["connect"]);
      await assert.rejects(manager.files.startDirectory(operator, changed.id), {
        code: "INVALID_CREDENTIAL",
        message: "Private-key data or passphrase is not usable.",
      });
      assert.equal(fixture.counts.auth, 0);
    });
  }
}
