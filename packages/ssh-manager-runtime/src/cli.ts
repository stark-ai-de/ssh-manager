#!/usr/bin/env node
import fs from "node:fs";
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
    if (command === "stop") {
      console.log(JSON.stringify(await client.stopRuntime()));
      return;
    }
    if (command === "vault-init") {
      console.log(
        JSON.stringify(
          await client.call("ssh_vault_initialize", {
            password: await secretPrompt("New vault password"),
          }),
        ),
      );
      return;
    }
    if (command === "vault-unlock") {
      console.log(
        JSON.stringify(
          await client.call("ssh_vault_unlock", { password: await secretPrompt("Vault password") }),
        ),
      );
      return;
    }
    if (command === "vault-lock") {
      console.log(JSON.stringify(await client.call("ssh_vault_lock", {})));
      return;
    }
    if (command === "vault-rotate") {
      console.log(
        JSON.stringify(
          await client.call("ssh_vault_rotate", {
            previousPassword: await secretPrompt("Previous vault password"),
            nextPassword: await secretPrompt("New vault password"),
          }),
        ),
      );
      return;
    }
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
    console.log(
      JSON.stringify(await client.call(name, definition.schema.parse(input) as any), null, 2),
    );
  } finally {
    await client.close();
  }
}
void main().catch((error) => {
  console.error(
    error.code
      ? `${error.code}: ${error.message}`
      : "Local setup failed. Check the operation, argument file and interactive terminal.",
  );
  process.exitCode = 1;
});
