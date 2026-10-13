import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const runtimeArtifactFormat = Object.freeze({
  schemaVersion: 1,
  managementApiVersion: "v1",
  nodeMinimum: "24.18.0",
  sourceRepository: "https://github.com/stark-ai-de/ssh-manager",
});
export const runtimeArtifactLimits = Object.freeze({
  manifestBytes: 1024 * 1024,
  files: 4096,
  fileBytes: 64 * 1024 * 1024,
});
export const requiredRuntimeFiles = [
  "mcp.mjs",
  "daemon.mjs",
  "cli.mjs",
  "BUILD-MANIFEST.json",
  "NOTICE.txt",
  "LICENSE",
  "viewer/index.html",
  "viewer/viewer.js",
  "viewer/viewer.css",
  "viewer/xterm.js",
  "viewer/xterm.css",
  "viewer/fit.js",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const fail = (message) => {
  throw new Error(message);
};
function parseManifest(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    fail("Artifact manifests must contain valid JSON.");
  }
}
function regularFile(file, maximum = runtimeArtifactLimits.fileBytes) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
    fail("Artifact must contain bounded regular files only.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      fail("Artifact changed during verification.");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      fail("Artifact changed during verification.");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/** Offline integrity verification, never execution. The caller supplies a separately trusted pin. */
export function verifyRuntimeArtifact(directory, { manifestSha256, sourceCommit } = {}) {
  if (typeof manifestSha256 !== "string" || !digest.test(manifestSha256))
    fail("A separately trusted lowercase manifest SHA-256 is required.");
  if (
    sourceCommit !== undefined &&
    (typeof sourceCommit !== "string" || !revision.test(sourceCommit))
  )
    fail("Expected source commit must be a complete lowercase Git revision.");
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Artifact root must be a real directory.");
  const bytes = regularFile(
    path.join(root, "ARTIFACT-MANIFEST.json"),
    runtimeArtifactLimits.manifestBytes,
  );
  if (sha256(bytes) !== manifestSha256)
    fail("Artifact manifest digest does not match the trusted pin.");
  const manifest = parseManifest(bytes);
  if (
    !manifest ||
    manifest.schemaVersion !== runtimeArtifactFormat.schemaVersion ||
    manifest.managementApiVersion !== runtimeArtifactFormat.managementApiVersion ||
    manifest.nodeMinimum !== runtimeArtifactFormat.nodeMinimum ||
    manifest.sourceRepository !== runtimeArtifactFormat.sourceRepository ||
    typeof manifest.sourceCommit !== "string" ||
    !revision.test(manifest.sourceCommit) ||
    typeof manifest.runtimeVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.runtimeVersion) ||
    typeof manifest.buildManifestSha256 !== "string" ||
    !digest.test(manifest.buildManifestSha256) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > runtimeArtifactLimits.files
  )
    fail("Unsupported or malformed artifact manifest.");
  if (sourceCommit !== undefined && manifest.sourceCommit !== sourceCommit)
    fail("Artifact source commit does not match the expected revision.");
  const files = new Map();
  const directories = new Set();
  let previous = "";
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(entry.path) ||
      entry.path.split("/").some((part) => part === "." || part === "..") ||
      entry.path === "ARTIFACT-MANIFEST.json" ||
      entry.path <= previous ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > runtimeArtifactLimits.fileBytes ||
      typeof entry.sha256 !== "string" ||
      !digest.test(entry.sha256)
    )
      fail("Artifact inventory must contain sorted, unique, safe paths, sizes and hashes.");
    previous = entry.path;
    files.set(entry.path, entry);
    const parts = entry.path.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  for (const name of requiredRuntimeFiles)
    if (!files.has(name)) fail("Artifact is missing a required runtime payload file.");
  const seen = new Set();
  function walk(relative = "") {
    for (const name of fs.readdirSync(path.join(root, relative))) {
      const item = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, item);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) fail("Artifact symlinks are forbidden.");
      if (info.isDirectory()) {
        if (!directories.has(item)) fail("Artifact contains an unexpected directory.");
        walk(item);
      } else {
        if (!info.isFile()) fail("Artifact special files are forbidden.");
        if (item === "ARTIFACT-MANIFEST.json") continue;
        const expected = files.get(item);
        if (!expected) fail("Artifact contains an unexpected file.");
        if (info.size !== expected.size) fail("Artifact file size does not match its inventory.");
        const content = regularFile(absolute);
        if (sha256(content) !== expected.sha256)
          fail("Artifact file digest does not match its inventory.");
        seen.add(item);
      }
    }
  }
  walk();
  if (seen.size !== files.size) fail("Artifact inventory contains missing files.");
  const buildBytes = regularFile(
    path.join(root, "BUILD-MANIFEST.json"),
    runtimeArtifactLimits.manifestBytes,
  );
  if (sha256(buildBytes) !== manifest.buildManifestSha256)
    fail("Build manifest digest does not match artifact metadata.");
  const build = parseManifest(buildBytes);
  if (
    build.schemaVersion !== 1 ||
    build.nodeMinimum !== manifest.nodeMinimum ||
    build.nativeAddons !== false
  )
    fail("Unsupported build manifest metadata.");
  // Detect a concurrent manifest replacement too; verify only an immutable, privately staged tree.
  if (
    sha256(
      regularFile(path.join(root, "ARTIFACT-MANIFEST.json"), runtimeArtifactLimits.manifestBytes),
    ) !== manifestSha256
  )
    fail("Artifact manifest changed during verification.");
  return {
    runtimeVersion: manifest.runtimeVersion,
    sourceCommit: manifest.sourceCommit,
    manifestSha256,
    files: seen.size,
  };
}
