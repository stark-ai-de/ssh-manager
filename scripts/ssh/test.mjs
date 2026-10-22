import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeSourceFiles } from "../lib/ssh-runtime-bundle.mjs";

const packages = ["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"];
// Tests import build output; never run them against a missing or stale build.
function current() {
  try {
    const { inputs } = JSON.parse(fs.readFileSync("dist/ssh-runtime/BUILD-MANIFEST.json", "utf8"));
    const sources = runtimeSourceFiles(process.cwd()).map((file) => ({
      path: file,
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    }));
    return (
      packages.every((name) => fs.existsSync(path.join("packages", name, "dist"))) &&
      JSON.stringify(inputs) === JSON.stringify(sources)
    );
  } catch {
    return false;
  }
}
if (!current()) {
  const build = spawnSync(process.execPath, ["scripts/ssh/build.mjs"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const tests = [
  ...packages.map((name) => path.join("packages", name, "test")),
  path.join("scripts", "test"),
].flatMap((directory) => {
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((f) => f.endsWith(".test.mjs"))
        .map((f) => path.join(directory, f))
    : [];
});
const result = spawnSync(
  process.execPath,
  ["--test", "--test-timeout=60000", "--test-reporter=tap", ...tests],
  {
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
