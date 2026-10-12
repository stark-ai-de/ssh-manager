import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildRuntimeBundle } from "../../../scripts/lib/ssh-runtime-bundle.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("library and MCP adapter retain their independent architectural boundaries", () => {
  const imports = (directory) =>
    fs
      .readdirSync(directory)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((file) => {
        const source = fs.readFileSync(path.join(directory, file), "utf8");
        return [...source.matchAll(/(?:\bfrom\s+|\bimport\s*[(]?\s*)["']([^"']+)["']/g)].map(
          (match) => match[1],
        );
      });
  assert.ok(
    imports(path.join(root, "packages/ssh-manager/src")).every(
      (name) => !/fastify|modelcontextprotocol|ssh-manager-runtime|ssh-manager-mcp/.test(name),
    ),
  );
  assert.ok(
    imports(path.join(root, "packages/ssh-manager-mcp/src")).every(
      (name) => !/^(?:ssh2|fastify|@stark-ai\/ssh-manager(?:$|\/))/.test(name),
    ),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "dist/ssh-runtime/BUILD-MANIFEST.json")),
  );
  assert.ok(
    manifest.entrySources["mcp.mjs"].every(
      (file) => !file.startsWith("packages/ssh-manager/src/") || file.endsWith("/contracts.ts"),
    ),
    "MCP bundle must not contain the SSH engine, state store or vault",
  );
  for (const file of fs
    .readdirSync(path.join(root, "packages/ssh-manager/dist"))
    .filter((f) => f.endsWith(".d.ts")))
    assert.doesNotMatch(
      fs.readFileSync(path.join(root, "packages/ssh-manager/dist", file), "utf8"),
      /modelcontextprotocol|fastify/,
    );
  const pending = ["index.d.ts"],
    visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const declaration = fs.readFileSync(path.join(root, "packages/ssh-manager/dist", file), "utf8");
    assert.doesNotMatch(
      declaration,
      /["'](?:ssh2|fastify|@modelcontextprotocol[^"']*)["']/,
      `Public declaration graph must stay adapter-independent: ${file}`,
    );
    for (const match of declaration.matchAll(/["']\.\/([^"']+)\.js["']/g))
      pending.push(`${match[1]}.d.ts`);
  }
});
test("runtime bundles are reproducible from isolated canonical sources without compiled packages", (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-build-contract-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const outputs = [];
  for (const name of ["first", "second"]) {
    const candidate = path.join(temporary, name);
    fs.mkdirSync(candidate);
    for (const file of [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/lib/ssh-runtime-bundle.mjs",
    ]) {
      fs.mkdirSync(path.dirname(path.join(candidate, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(candidate, file));
    }
    for (const pkg of ["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"]) {
      const directory = path.join(candidate, "packages", pkg);
      fs.mkdirSync(directory, { recursive: true });
      for (const file of ["src", "package.json", "tsconfig.json"])
        fs.cpSync(path.join(root, "packages", pkg, file), path.join(directory, file), {
          recursive: true,
        });
    }
    fs.cpSync(
      path.join(root, "packages/ssh-manager-runtime/viewer"),
      path.join(candidate, "packages/ssh-manager-runtime/viewer"),
      { recursive: true },
    );
    const output = path.join(candidate, "output");
    buildRuntimeBundle({ root: candidate, output, dependencyRoot: root });
    outputs.push(output);
  }
  for (const file of [
    "mcp.mjs",
    "daemon.mjs",
    "cli.mjs",
    "BUILD-MANIFEST.json",
    "NOTICE.txt",
    "viewer/xterm.js",
    "viewer/fit.js",
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(outputs[0], file)),
      fs.readFileSync(path.join(outputs[1], file)),
      `${file} must be byte-identical`,
    );
    assert.ok(
      !fs.readFileSync(path.join(outputs[0], file), "utf8").includes(root),
      "No local absolute repository path may leak into bundles",
    );
  }
});
