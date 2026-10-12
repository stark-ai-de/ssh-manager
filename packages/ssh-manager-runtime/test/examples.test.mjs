import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import MarkdownIt from "markdown-it";
import { catalog } from "../dist/catalog.js";
import { createRuntime } from "../dist/server.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);

test("first-connection JSON examples match the real management operation schemas", () => {
  const examples = new MarkdownIt()
    .parse(fs.readFileSync(path.join(root, "docs/getting-started.md"), "utf8"), {})
    .filter((token) => token.type === "fence" && token.info === "json")
    .map((token) => JSON.parse(token.content));
  const operations = [
    "ssh_credential_add",
    "ssh_host_create",
    "ssh_host_inspect",
    "ssh_host_confirm",
    "ssh_grants_set",
    "ssh_job_start",
    "ssh_job_read",
  ];
  assert.equal(examples.length, operations.length);
  operations.forEach((name, index) => catalog[name].schema.parse(examples[index]));
  assert.equal(examples[0].reference.kind, "agent");
  assert.equal(examples[0].secret, undefined);
  assert.deepEqual(examples[4].capabilities, ["connect"]);
});

test("typed-client example uses isolated explicit state and leaves the daemon running", async (t) => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-client-example-"));
  const runtime = await createRuntime({ stateDirectory, knownHosts: [] });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(stateDirectory, "runtime.json"),
    JSON.stringify({ url: runtime.url, pid: process.pid }),
  );
  const example = path.join(root, "packages/ssh-manager-runtime/examples/list-hosts.mjs");
  const result = await execute(process.execPath, [example, stateDirectory], { timeout: 15000 });
  assert.deepEqual(JSON.parse(result.stdout), []);
  assert.equal(result.stderr, "");
  assert.deepEqual(runtime.manager.profiles({ id: "fixture", kind: "agent" }), []);
  await assert.rejects(execute(process.execPath, [example], { timeout: 5000 }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Usage:/);
    return true;
  });
});
