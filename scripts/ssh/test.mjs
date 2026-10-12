import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tests = [
  ...["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"].map((name) =>
    path.join("packages", name, "test"),
  ),
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
