import fs from "node:fs";
import path from "node:path";
import { argon2, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { fault, type CredentialSecret } from "./contracts.js";
import { atomicJson, privateDirectory } from "./util.js";

type Box = { nonce: string; ciphertext: string; tag: string };
type Envelope = {
  schema: 1;
  kdf: { algorithm: "argon2id"; memory: 65536; passes: 3; parallelism: 4; salt: string };
  wrappedKey: Box;
  records: Record<string, Box>;
};
const context = "ssh-manager-vault:1:";
function seal(key: Buffer, plaintext: Buffer, aad: string): Box {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context + aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function open(key: Buffer, box: Box, aad: string) {
  try {
    if (
      Buffer.from(box.nonce, "base64").length !== 12 ||
      Buffer.from(box.tag, "base64").length !== 16
    )
      throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce, "base64"));
    cipher.setAAD(Buffer.from(context + aad));
    cipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([cipher.update(Buffer.from(box.ciphertext, "base64")), cipher.final()]);
  } catch {
    fault("VAULT_AUTHENTICATION", "Incorrect vault password or damaged authenticated vault data.");
  }
}
function validate(document: Envelope) {
  if (
    document?.schema !== 1 ||
    document.kdf?.algorithm !== "argon2id" ||
    document.kdf.memory !== 65536 ||
    document.kdf.passes !== 3 ||
    document.kdf.parallelism !== 4 ||
    Buffer.from(document.kdf.salt ?? "", "base64").length !== 16 ||
    !document.wrappedKey ||
    !document.records ||
    Object.keys(document.records).length > 512 ||
    JSON.stringify(document).length > 32 * 1024 * 1024
  )
    fault("VAULT_VERSION", "Unsupported or invalid vault format; no data was changed.");
}
async function derive(password: string, kdf: Envelope["kdf"]) {
  const bytes = Buffer.from(password);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      argon2(
        "argon2id",
        {
          message: bytes,
          nonce: Buffer.from(kdf.salt, "base64"),
          memory: kdf.memory,
          passes: kdf.passes,
          parallelism: kdf.parallelism,
          tagLength: 32,
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      );
    }).catch(async (error: unknown) => {
      // Electron exposes the API but BoringSSL cannot execute it. Preserve the exact KDF;
      // authentication errors and all other backend failures must never trigger a retry.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ERR_CRYPTO_ARGON2_NOT_SUPPORTED"
      )
        throw error;
      const { argon2id } = await import("hash-wasm");
      const result = await argon2id({
        password: bytes,
        salt: Buffer.from(kdf.salt, "base64"),
        memorySize: kdf.memory,
        iterations: kdf.passes,
        parallelism: kdf.parallelism,
        hashLength: 32,
        outputType: "binary",
      });
      try {
        return Buffer.from(result);
      } finally {
        result.fill(0);
      }
    });
  } finally {
    bytes.fill(0);
  }
}

export class Vault {
  private document?: Envelope;
  private key?: Buffer;
  private epoch = 0;
  private busy = false;
  private closed = false;
  readonly file: string;
  constructor(directory: string) {
    privateDirectory(directory);
    this.file = path.join(directory, "vault.json");
    if (fs.existsSync(this.file)) {
      if (
        fs.lstatSync(this.file).isSymbolicLink() ||
        fs.statSync(this.file).size > 32 * 1024 * 1024
      )
        fault("UNSAFE_STATE", "Invalid vault file.");
      try {
        this.document = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        fault("VAULT_CORRUPT", "Vault file is not valid JSON; retain it for recovery.");
      }
      validate(this.document!);
    }
  }
  private active() {
    if (this.closed) fault("CLOSED", "Vault owner has shut down.");
  }
  status() {
    this.active();
    return {
      initialized: !!this.document,
      locked: !this.key,
      recordCount: Object.keys(this.document?.records ?? {}).length,
    };
  }
  private async exclusive(operation: () => Promise<void>) {
    this.active();
    if (this.busy) fault("LIMIT", "A vault key operation is already running.");
    this.busy = true;
    try {
      await operation();
    } finally {
      this.busy = false;
    }
  }
  initialize(password: string) {
    return this.exclusive(() => this.initializeInternal(password));
  }
  private async initializeInternal(password: string) {
    if (this.document) fault("CONFLICT", "Vault is already initialized.");
    if (password.length < 12)
      fault("INVALID_ARGUMENT", "Use a vault password with at least twelve characters.");
    const epoch = this.epoch;
    const kdf: Envelope["kdf"] = {
      algorithm: "argon2id",
      memory: 65536,
      passes: 3,
      parallelism: 4,
      salt: randomBytes(16).toString("base64"),
    };
    const kek = await derive(password, kdf);
    const key = randomBytes(32);
    try {
      if (epoch !== this.epoch || this.document)
        fault("CONFLICT", "Vault state changed during initialization.");
      const document: Envelope = {
        schema: 1,
        kdf,
        wrappedKey: seal(kek, key, JSON.stringify(kdf)),
        records: {},
      };
      atomicJson(this.file, document);
      this.document = document;
      this.key = Buffer.from(key);
      this.epoch++;
    } finally {
      kek.fill(0);
      key.fill(0);
    }
  }
  unlock(password: string) {
    return this.exclusive(() => this.unlockInternal(password));
  }
  private async unlockInternal(password: string) {
    if (!this.document) fault("VAULT_UNINITIALIZED", "Initialize the vault through local setup.");
    const epoch = this.epoch;
    const document = this.document;
    const kek = await derive(password, document.kdf);
    let key: Buffer | undefined;
    try {
      key = open(kek, document.wrappedKey, JSON.stringify(document.kdf));
      if (key.length !== 32) fault("VAULT_AUTHENTICATION", "Invalid encrypted data key.");
      this.verifyRecords(document, key);
      if (epoch !== this.epoch) fault("CONFLICT", "Vault state changed during unlock.");
      this.key?.fill(0);
      this.key = Buffer.from(key);
      this.epoch++;
    } finally {
      kek.fill(0);
      key?.fill(0);
    }
  }
  lock() {
    this.key?.fill(0);
    this.key = undefined;
    this.epoch++;
  }
  close() {
    this.lock();
    this.closed = true;
  }
  get(recordId: string): CredentialSecret {
    this.active();
    if (!this.key || !this.document)
      fault(
        "VAULT_LOCKED",
        "Unlock the local vault before a new authentication or recording access.",
      );
    const box = this.document.records[recordId];
    if (!box) fault("NOT_FOUND", "Credential record does not exist.");
    const bytes = open(this.key, box, recordId);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      fault("VAULT_AUTHENTICATION", "Encrypted record has an invalid format.");
    } finally {
      bytes.fill(0);
    }
  }
  put(recordId: string, secret: CredentialSecret) {
    this.active();
    if (!this.key || !this.document)
      fault("VAULT_LOCKED", "Unlock the vault to store credentials or recordings.");
    if (
      typeof secret.value !== "string" ||
      (secret.passphrase !== undefined && typeof secret.passphrase !== "string")
    )
      fault("INVALID_CREDENTIAL", "Invalid secret input.");
    if (Buffer.byteLength(JSON.stringify(secret)) > 2 * 1024 * 1024)
      fault("LIMIT", "Encrypted record exceeds its size limit.");
    const draft = structuredClone(this.document);
    if (!(recordId in draft.records) && Object.keys(draft.records).length >= 512)
      fault("LIMIT", "Vault record limit reached.");
    const bytes = Buffer.from(JSON.stringify(secret));
    try {
      draft.records[recordId] = seal(this.key, bytes, recordId);
      validate(draft);
      atomicJson(this.file, draft);
      this.document = draft;
      this.epoch++;
    } finally {
      bytes.fill(0);
    }
  }
  remove(recordId: string) {
    this.active();
    if (!this.key || !this.document)
      fault("VAULT_LOCKED", "Unlock the vault before removing encrypted records.");
    const draft = structuredClone(this.document);
    delete draft.records[recordId];
    atomicJson(this.file, draft);
    this.document = draft;
    this.epoch++;
  }
  rotate(oldPassword: string, newPassword: string) {
    return this.exclusive(() => this.rotateInternal(oldPassword, newPassword));
  }
  private async rotateInternal(oldPassword: string, newPassword: string) {
    if (!this.document) fault("VAULT_UNINITIALIZED", "Vault is not initialized.");
    if (newPassword.length < 12)
      fault("INVALID_ARGUMENT", "Use a vault password with at least twelve characters.");
    const epoch = this.epoch;
    const document = this.document;
    const previous = await derive(oldPassword, document.kdf);
    let key: Buffer | undefined, replacement: Buffer | undefined;
    try {
      key = open(previous, document.wrappedKey, JSON.stringify(document.kdf));
      this.verifyRecords(document, key);
      const kdf = { ...document.kdf, salt: randomBytes(16).toString("base64") };
      replacement = await derive(newPassword, kdf);
      if (epoch !== this.epoch) fault("CONFLICT", "Vault state changed during password rotation.");
      const draft = { ...document, kdf, wrappedKey: seal(replacement, key, JSON.stringify(kdf)) };
      atomicJson(this.file, draft);
      this.document = draft;
      this.epoch++;
    } finally {
      previous.fill(0);
      replacement?.fill(0);
      key?.fill(0);
    }
  }
  backup() {
    this.active();
    if (!this.document) fault("VAULT_UNINITIALIZED", "Vault is not initialized.");
    return structuredClone(this.document);
  }
  restore(input: unknown, password: string) {
    return this.exclusive(() => this.restoreInternal(input, password));
  }
  private async restoreInternal(input: unknown, password: string) {
    const document = structuredClone(input) as Envelope;
    validate(document);
    const epoch = this.epoch;
    const kek = await derive(password, document.kdf);
    let key: Buffer | undefined;
    try {
      key = open(kek, document.wrappedKey, JSON.stringify(document.kdf));
      this.verifyRecords(document, key);
      if (epoch !== this.epoch) fault("CONFLICT", "Vault state changed during restore.");
      if (this.document)
        atomicJson(path.join(path.dirname(this.file), "vault.before-restore.json"), this.document);
      atomicJson(this.file, document);
      this.lock();
      this.document = document;
    } finally {
      kek.fill(0);
      key?.fill(0);
    }
  }
  private verifyRecords(document: Envelope, key: Buffer) {
    for (const [recordId, box] of Object.entries(document.records)) {
      const bytes = open(key, box, recordId);
      try {
        const data = JSON.parse(bytes.toString("utf8"));
        if (typeof data.value !== "string") throw new Error();
      } catch {
        fault("VAULT_AUTHENTICATION", "Vault contains an invalid encrypted record.");
      } finally {
        bytes.fill(0);
      }
    }
  }
}
