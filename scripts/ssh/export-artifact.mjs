import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { produceRuntimeArtifact } from "../lib/ssh-runtime-artifact-production.mjs";

try {
  const root = process.cwd();
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Artifact export requires clean committed source.");
  const sourceCommit = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Invalid source revision.");
  const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const source = path.join(root, "dist/ssh-runtime");
  const build = JSON.parse(fs.readFileSync(path.join(source, "BUILD-MANIFEST.json")));
  for (const input of build.inputs) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(input.path) || input.path.split("/").includes(".."))
      throw new Error("Unsafe build input.");
    const committed = execFileSync("git", ["show", `${sourceCommit}:${input.path}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (
      hash(committed) !== input.sha256 ||
      hash(fs.readFileSync(path.join(root, input.path))) !== input.sha256
    )
      throw new Error("Stale build input.");
  }
  const accepted = produceRuntimeArtifact({
    bundleDirectory: source,
    outputDirectory: path.join(root, "dist/artifact/runtime"),
    licenseFile: path.join(root, "LICENSE"),
    runtimeVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
    sourceCommit,
  });
  console.log(`Exported runtime ${accepted.runtimeVersion} from ${accepted.sourceCommit}.`);
} catch (error) {
  // Do not expose private paths or raw Git/filesystem diagnostics in public evidence.
  console.error(
    "Artifact export failed. Require clean committed source, matching build inputs and an accepted runtime payload.",
  );
  if (error instanceof AggregateError)
    console.error(
      "Previous artifact restoration failed; recovery staging was retained beside the output directory.",
    );
  process.exitCode = 1;
}
