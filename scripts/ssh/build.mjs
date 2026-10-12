import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildRuntimeBundle } from "../lib/ssh-runtime-bundle.mjs";

for (const name of ["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"]) {
  const directory = path.resolve("packages", name);
  const result = spawnSync(
    process.execPath,
    [
      path.join(directory, "node_modules/typescript/lib/tsc.js"),
      "-p",
      path.join(directory, "tsconfig.json"),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  fs.copyFileSync("LICENSE", path.join(directory, "dist/LICENSE"));
}
buildRuntimeBundle({ root: process.cwd(), output: path.resolve("dist/ssh-runtime") });
console.log("Built the independent library, API runtime, MCP bridge and portable runtime bundle.");
