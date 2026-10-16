import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { verifyMcpSdkCompatibility } from "../lib/ssh-runtime-bundle.mjs";

test("MCP lifecycle builds use the audited published SDK; drift requires a new audit", (t) => {
  verifyMcpSdkCompatibility(process.cwd());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-sdk-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const require = createRequire(path.resolve("packages/ssh-manager-mcp/package.json"));
  const installed = path.dirname(require.resolve("@modelcontextprotocol/server/stdio"));
  const pkg = path.join(root, "packages/ssh-manager-mcp/node_modules/@modelcontextprotocol/server");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  const metadata = {
    name: "@modelcontextprotocol/server",
    version: "2.3.1",
    exports: { "./stdio": "./dist/stdio.cjs" },
  };
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(pkg, "dist/stdio.cjs"), "");
  for (const name of ["stdio.mjs", "mcp-DIH4cS6P.mjs", "src-Cqbh3MYc.mjs"])
    fs.copyFileSync(path.join(installed, name), path.join(pkg, "dist", name));
  verifyMcpSdkCompatibility(root);
  fs.appendFileSync(path.join(pkg, "dist/stdio.mjs"), "// changed\n");
  assert.throws(() => verifyMcpSdkCompatibility(root), /source changed/);
  fs.copyFileSync(path.join(installed, "stdio.mjs"), path.join(pkg, "dist/stdio.mjs"));
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ ...metadata, version: "2.3.2" }),
  );
  assert.throws(() => verifyMcpSdkCompatibility(root), /requires published SDK 2.3.1/);
});
