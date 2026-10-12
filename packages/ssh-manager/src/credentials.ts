import fs from "node:fs";
import { fault, type CredentialRef, type CredentialSecret } from "./contracts.js";
import { StateStore } from "./state.js";
import { Vault } from "./vault.js";

/** A trusted embedder can provide agent sockets, hardware-backed signing or external secret retrieval. */
export interface CredentialProvider {
  resolve(
    reference: CredentialRef,
    signal?: AbortSignal,
  ): Promise<{ agent?: string; privateKey?: Buffer; passphrase?: string; password?: string }>;
}
export class LocalCredentialProvider implements CredentialProvider {
  constructor(
    private state: StateStore,
    private vault: Vault,
  ) {}
  async resolve(
    reference: CredentialRef,
    signal?: AbortSignal,
  ): ReturnType<CredentialProvider["resolve"]> {
    signal?.throwIfAborted();
    if (reference.kind === "agent") return { agent: reference.socket };
    const passphrase = reference.passphraseId
      ? this.vault.get(reference.passphraseId).value
      : undefined;
    if (reference.kind === "key-file") {
      const stat = fs.statSync(reference.path);
      if (!stat.isFile() || stat.size > 1024 * 1024)
        fault("INVALID_CREDENTIAL", "Key reference must point to a bounded regular file.");
      if (process.platform !== "win32" && stat.mode & 0o022)
        fault("INVALID_CREDENTIAL", "Private key must not be group- or world-writable.");
      return { privateKey: fs.readFileSync(reference.path), passphrase };
    }
    const secret: CredentialSecret = this.vault.get(reference.id);
    if (reference.secretKind === "password") return { password: secret.value };
    if (reference.secretKind === "private-key")
      return { privateKey: Buffer.from(secret.value), passphrase: secret.passphrase ?? passphrase };
    fault("INVALID_CREDENTIAL", "Passphrase entries cannot authenticate on their own.");
  }
}
