import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  runtimeArtifactFormat,
  runtimeArtifactLimits,
  verifyRuntimeArtifact,
} from "./ssh-runtime-artifact.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
function existingDirectory(directory) {
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Artifact directories must be real directories.");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Resolve missing parents without creating them; existing links must resolve successfully.
function prospectiveRealpath(directory) {
  const missing = [];
  let ancestor = directory;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Artifact output ancestor is missing.");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

/**
 * Produce and verify before replacing output. The caller establishes Git provenance.
 * The generated digest proves contract agreement here, not publisher authentication.
 * Use stable private directories and one producer; replacement is not crash-atomic.
 */
export function produceRuntimeArtifact({
  bundleDirectory,
  outputDirectory,
  licenseFile,
  runtimeVersion,
  sourceCommit,
}) {
  const source = path.resolve(bundleDirectory);
  const output = path.resolve(outputDirectory);
  if (contains(source, output) || contains(output, source))
    throw new Error("Artifact source and output directories must not overlap.");
  if (!existingDirectory(source)) throw new Error("Runtime bundle directory is missing.");
  const parent = path.dirname(output);
  // Check aliases before creating even missing parents, which may lie inside the source.
  const canonicalSource = fs.realpathSync(source);
  const canonicalOutput = path.join(prospectiveRealpath(parent), path.basename(output));
  if (contains(canonicalSource, canonicalOutput) || contains(canonicalOutput, canonicalSource))
    throw new Error("Artifact source and output directories must not overlap.");
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, ".runtime-export-"));
  const candidate = path.join(staging, "candidate");
  const previous = path.join(staging, "previous");
  let retainRecovery = false;
  try {
    fs.cpSync(source, candidate, { recursive: true, dereference: false });
    // Do not overwrite a manifest inherited from an already-exported bundle.
    if (fs.lstatSync(path.join(candidate, "ARTIFACT-MANIFEST.json"), { throwIfNoEntry: false }))
      throw new Error("Runtime bundle must not contain an artifact manifest.");
    const licenseInfo = fs.lstatSync(licenseFile);
    if (
      !licenseInfo.isFile() ||
      licenseInfo.isSymbolicLink() ||
      licenseInfo.size > runtimeArtifactLimits.fileBytes
    )
      throw new Error("Artifact license must be a bounded regular file.");
    const candidateLicense = path.join(candidate, "LICENSE");
    const copiedLicense = fs.lstatSync(candidateLicense, { throwIfNoEntry: false });
    if (copiedLicense && (!copiedLicense.isFile() || copiedLicense.isSymbolicLink()))
      throw new Error("Runtime bundle license must be a regular file.");
    fs.copyFileSync(licenseFile, candidateLicense);
    const files = [];
    function walk(directory, prefix = "") {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, `${relative}/`);
        else if (entry.isFile()) {
          if (
            files.length >= runtimeArtifactLimits.files ||
            fs.lstatSync(absolute).size > runtimeArtifactLimits.fileBytes
          )
            throw new Error("Runtime payload exceeds artifact inventory limits.");
          const bytes = fs.readFileSync(absolute);
          files.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
        } else throw new Error("Artifact contains a symlink or special file.");
      }
    }
    walk(candidate);
    files.sort((a, b) => {
      if (a.path < b.path) return -1;
      return a.path > b.path ? 1 : 0;
    });
    const manifest = {
      ...runtimeArtifactFormat,
      runtimeVersion,
      sourceCommit,
      buildManifestSha256: files.find((file) => file.path === "BUILD-MANIFEST.json")?.sha256,
      files,
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (bytes.length > runtimeArtifactLimits.manifestBytes)
      throw new Error("Runtime artifact manifest exceeds its size limit.");
    fs.writeFileSync(path.join(candidate, "ARTIFACT-MANIFEST.json"), bytes);
    const accepted = verifyRuntimeArtifact(candidate, {
      manifestSha256: hash(bytes),
      sourceCommit,
    });
    const hadPrevious = existingDirectory(output);
    if (hadPrevious) fs.renameSync(output, previous);
    try {
      fs.renameSync(candidate, output);
    } catch (promotionError) {
      if (hadPrevious) {
        try {
          fs.renameSync(previous, output);
        } catch (restorationError) {
          retainRecovery = true;
          throw new AggregateError(
            [promotionError, restorationError],
            "Artifact promotion and restoration failed; previous artifact retained in staging beside output.",
          );
        }
      }
      throw new Error("Artifact promotion failed; previous output was preserved.", {
        cause: promotionError,
      });
    }
    return accepted;
  } finally {
    // A failed restoration must never delete the only remaining previous artifact.
    if (!retainRecovery) fs.rmSync(staging, { recursive: true, force: true });
  }
}
