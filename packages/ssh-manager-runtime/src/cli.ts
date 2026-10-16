#!/usr/bin/env node
import fs from "node:fs";
import type { ManagementClient, ClientCallOptions } from "./client.js";
import type { OperationInputs } from "./catalog.js";
import path from "node:path";
import { catalog, type Operation } from "./catalog.js";
import { localClient, ensureRuntime } from "./launcher.js";

async function secretPrompt(label: string) {
  if (!process.stdin.isTTY) throw new Error("Secret setup requires a local interactive terminal.");
  process.stderr.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const data = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    process.stdin.on("data", data);
  });
}
export const supportsScopedManagementCli = true;
export async function runManagementCliOperation<K extends Operation>(
  operation: K,
  input: unknown,
  options: {
    client: ManagementClient;
    callOptions?: ClientCallOptions;
    invoke?: (
      operation: K,
      input: OperationInputs[K],
      client: ManagementClient,
    ) => Promise<unknown>;
  },
) {
  if (!Object.hasOwn(catalog, operation)) throw new Error("Choose a documented operation.");
  const parsed = catalog[operation].schema.parse(input) as OperationInputs[K];
  return options.invoke
    ? options.invoke(operation, parsed, options.client)
    : options.client.call(operation, parsed, { ...options.callOptions, joinPhysical: true });
}
async function main() {
  const args = process.argv.slice(2);
  const directoryIndex = args.indexOf("--state-directory");
  const stateDirectory = directoryIndex < 0 ? undefined : path.resolve(args[directoryIndex + 1]!);
  if (directoryIndex >= 0) args.splice(directoryIndex, 2);
  const command = args[0];
  if (command === "start" || command === "viewer") {
    const runtime = await ensureRuntime({ stateDirectory });
    console.log(command === "viewer" ? `${runtime.url}/` : JSON.stringify(runtime));
    return;
  }
  if (command === "help" || !command) {
    console.log(
      "ssh-management start | viewer | stop | vault-init | vault-unlock | vault-lock | vault-rotate | operator <operation> <JSON-file> [--state-directory <native path>]\nOperator setup uses an interactive local terminal. JSON files contain profile/setup arguments, not shell command substitutions.",
    );
    console.log(
      Object.entries(catalog)
        .filter(([, c]) => c.operator)
        .map(([name, c]) => `${name}: ${c.description}`)
        .join("\n"),
    );
    return;
  }
  const client = await localClient("operator", { stateDirectory });
  try {
    let result: unknown;
    if (command === "stop") {
      result = await client.stopRuntime();
    } else if (command === "vault-init") {
      result = await client.call("ssh_vault_initialize", {
        password: await secretPrompt("New vault password"),
      });
    } else if (command === "vault-unlock") {
      result = await client.call("ssh_vault_unlock", {
        password: await secretPrompt("Vault password"),
      });
    } else if (command === "vault-lock") {
      result = await client.call("ssh_vault_lock", {});
    } else if (command === "vault-rotate") {
      result = await client.call("ssh_vault_rotate", {
        previousPassword: await secretPrompt("Previous vault password"),
        nextPassword: await secretPrompt("New vault password"),
      });
    } else {
      if (command !== "operator" || !args[1] || !(args[1] in catalog) || !args[2])
        throw new Error("Choose a documented operation and a local JSON argument file.");
      const name = args[1] as Operation;
      const definition = catalog[name];
      const input = JSON.parse(fs.readFileSync(path.resolve(args[2]), "utf8"));
      if (definition.operator) {
        if (!process.stdin.isTTY)
          throw new Error(
            "Permission, trust and credential setup requires a local interactive operator terminal.",
          );
        const confirmation = await secretPrompt(
          name === "ssh_host_confirm"
            ? `Type the reviewed fingerprint ${input.fingerprint}`
            : `Type ${name} to authorize this local setup action`,
        );
        if (confirmation !== (name === "ssh_host_confirm" ? input.fingerprint : name))
          throw new Error("Confirmation did not match.");
      }
      result = await runManagementCliOperation(name, input, { client });
    }
    console.log(JSON.stringify(result, null, command === "operator" ? 2 : undefined));
  } finally {
    await client.close();
  }
}
if (import.meta.main)
  void main().catch((error) => {
    console.error(
      error.code
        ? `${error.code}: ${error.message}`
        : "Local setup failed. Check the operation, argument file and interactive terminal.",
    );
    process.exitCode = 1;
  });
