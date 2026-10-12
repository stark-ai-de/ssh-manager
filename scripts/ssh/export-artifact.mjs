import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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
  const committed = execFileSync("git", ["show", `${sourceCommit}:${input.path}`], { cwd: root });
  if (
    hash(committed) !== input.sha256 ||
    hash(fs.readFileSync(path.join(root, input.path))) !== input.sha256
  )
    throw new Error(`Stale build input: ${input.path}`);
}
const output = path.join(root, "dist/artifact/runtime");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true });
fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
const files = [];
function walk(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, `${relative}/`);
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(absolute);
      files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
    } else throw new Error("Artifact contains a symlink or special file.");
  }
}
walk(output);
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const manifest = {
  schemaVersion: 1,
  runtimeVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
  managementApiVersion: "v1",
  nodeMinimum: "24.18.0",
  sourceRepository: "https://github.com/stark-ai-de/ssh-manager",
  sourceCommit,
  buildManifestSha256: hash(fs.readFileSync(path.join(output, "BUILD-MANIFEST.json"))),
  files,
};
fs.writeFileSync(
  path.join(output, "ARTIFACT-MANIFEST.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Exported runtime ${manifest.runtimeVersion} from ${sourceCommit}.`);
