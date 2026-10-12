import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { requiredRuntimeFiles, verifyRuntimeArtifact } from "../lib/ssh-runtime-artifact.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-artifact-verifier-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of requiredRuntimeFiles) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `fixture ${file}\n`);
  }
  fs.writeFileSync(
    path.join(root, "BUILD-MANIFEST.json"),
    JSON.stringify({ schemaVersion: 1, nodeMinimum: "24.18.0", nativeAddons: false }),
  );
  const manifest = {
    schemaVersion: 1,
    runtimeVersion: "1.0.0",
    managementApiVersion: "v1",
    nodeMinimum: "24.18.0",
    sourceRepository: "https://github.com/stark-ai-de/ssh-manager",
    sourceCommit: "a".repeat(40),
    buildManifestSha256: hash(fs.readFileSync(path.join(root, "BUILD-MANIFEST.json"))),
    files: [...requiredRuntimeFiles].sort().map((file) => {
      const bytes = fs.readFileSync(path.join(root, file));
      return { path: file, size: bytes.length, sha256: hash(bytes) };
    }),
  };
  const save = () => {
    const bytes = JSON.stringify(manifest);
    fs.writeFileSync(path.join(root, "ARTIFACT-MANIFEST.json"), bytes);
    return { manifestSha256: hash(bytes), sourceCommit: manifest.sourceCommit };
  };
  return { root, manifest, save, pin: save() };
}

test("artifact verification needs a trusted pin and checks the expected producer revision", (t) => {
  const f = fixture(t);
  assert.equal(verifyRuntimeArtifact(f.root, f.pin).files, requiredRuntimeFiles.length);
  assert.throws(() => verifyRuntimeArtifact(f.root), /trusted/);
  assert.throws(
    () => verifyRuntimeArtifact(f.root, { ...f.pin, manifestSha256: "b".repeat(64) }),
    /pin/,
  );
  assert.throws(
    () => verifyRuntimeArtifact(f.root, { ...f.pin, sourceCommit: "b".repeat(40) }),
    /revision/,
  );
  const cli = spawnSync(
    process.execPath,
    ["scripts/ssh/verify-artifact.mjs", f.root, f.pin.manifestSha256, f.pin.sourceCommit],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).sourceCommit, f.pin.sourceCommit);
  const missingPin = spawnSync(process.execPath, ["scripts/ssh/verify-artifact.mjs", f.root], {
    encoding: "utf8",
  });
  assert.equal(missingPin.status, 1);
});

test("artifact verifier rejects missing, extra and modified payload entries", async (t) => {
  for (const mutation of [
    (f) => fs.unlinkSync(path.join(f.root, "cli.mjs")),
    (f) => fs.writeFileSync(path.join(f.root, "unexpected.token"), "synthetic-only"),
    (f) => fs.mkdirSync(path.join(f.root, "unlisted-directory")),
    (f) =>
      fs.writeFileSync(
        path.join(f.root, "mcp.mjs"),
        "x".repeat(fs.statSync(path.join(f.root, "mcp.mjs")).size),
      ),
    (f) => fs.writeFileSync(path.join(f.root, "daemon.mjs"), "short"),
  ])
    await t.test(mutation.toString(), (t) => {
      const f = fixture(t);
      mutation(f);
      assert.throws(() => verifyRuntimeArtifact(f.root, f.pin));
    });
});

test("artifact verifier rejects malformed, duplicate, unsorted and escaping inventories even with a matching pin", async (t) => {
  for (const bad of [
    "../outside",
    "/absolute",
    "C:\\escape",
    "viewer/../outside",
    "./cli.mjs",
    "ARTIFACT-MANIFEST.json",
  ]) {
    await t.test(bad, (t) => {
      const f = fixture(t);
      f.manifest.files[0].path = bad;
      assert.throws(() => verifyRuntimeArtifact(f.root, f.save()), /inventory/);
    });
  }
  for (const mutation of [
    (m) => m.files.reverse(),
    (m) => m.files.push(m.files.at(-1)),
    (m) => {
      m.files[0].size = -1;
    },
    (m) => {
      m.files[0] = null;
    },
    (m) => {
      m.files = [];
    },
    (m) => {
      m.sourceRepository = "https://example.test/untrusted";
    },
    (m) => {
      m.buildManifestSha256 = "b".repeat(64);
    },
    (m) => {
      m.files = m.files.filter((f) => f.path !== "cli.mjs");
    },
  ])
    await t.test(mutation.toString(), (t) => {
      const f = fixture(t);
      mutation(f.manifest);
      assert.throws(() => verifyRuntimeArtifact(f.root, f.save()));
    });
});

test("artifact verifier rejects symlinked files, directories and roots", async (t) => {
  for (const target of ["cli.mjs", "viewer", "root"])
    await t.test(target, (t) => {
      const f = fixture(t);
      const link = path.join(f.root, "link");
      try {
        fs.symlinkSync(
          path.join(f.root, target === "root" ? "." : target),
          link,
          target === "cli.mjs" ? "file" : "junction",
        );
      } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM")
          return t.skip("Creating file symlinks requires Windows developer mode or privileges.");
        throw error;
      }
      assert.throws(
        () => verifyRuntimeArtifact(target === "root" ? link : f.root, f.pin),
        /symlink|real directory/,
      );
    });
});
