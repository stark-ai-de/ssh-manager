import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { produceRuntimeArtifact } from "../lib/ssh-runtime-artifact-production.mjs";
import { verifyRuntimeArtifact } from "../lib/ssh-runtime-artifact.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exportCommand = fileURLToPath(new URL("../ssh/export-artifact.mjs", import.meta.url));
// Intentionally independent of production format constants and required-file enumeration.
const payload = [
  "mcp.mjs",
  "daemon.mjs",
  "cli.mjs",
  "NOTICE.txt",
  "viewer/index.html",
  "viewer/viewer.js",
  "viewer/viewer.css",
  "viewer/xterm.js",
  "viewer/xterm.css",
  "viewer/fit.js",
];
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-artifact-production-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundleDirectory = path.join(root, "dist", "ssh-runtime");
  for (const file of payload) {
    const target = path.join(bundleDirectory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Executing this payload would fail; production and verification must only read it.
    fs.writeFileSync(target, "throw new Error('candidate must not execute');\n");
  }
  const buildFile = path.join(bundleDirectory, "BUILD-MANIFEST.json");
  fs.writeFileSync(
    buildFile,
    JSON.stringify({ schemaVersion: 1, nodeMinimum: "24.18.0", nativeAddons: false, inputs: [] }),
  );
  const licenseFile = path.join(root, "LICENSE");
  fs.writeFileSync(licenseFile, "Synthetic fixture license\n");
  const options = {
    bundleDirectory,
    outputDirectory: path.join(root, "dist", "artifact", "runtime"),
    licenseFile,
    runtimeVersion: "1.0.0",
    sourceCommit: "a".repeat(40),
  };
  return { root, buildFile, options };
}
function snapshot(directory) {
  const files = [];
  function walk(relative = "") {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else files.push([file, hash(fs.readFileSync(path.join(directory, file)))]);
    }
  }
  walk();
  return files.sort(([a], [b]) => a.localeCompare(b));
}
function noStaging(options) {
  assert.deepEqual(fs.readdirSync(path.dirname(options.outputDirectory)), ["runtime"]);
}

test("production returns consumer-accepted metadata and replaces complete output without executing payload", (t) => {
  const { options } = fixture(t);
  const first = produceRuntimeArtifact(options);
  assert.deepEqual(verifyRuntimeArtifact(options.outputDirectory, first), first);
  assert.equal(first.files, 12);
  assert.equal(first.runtimeVersion, "1.0.0");
  assert.equal(first.sourceCommit, "a".repeat(40));
  noStaging(options);
  fs.writeFileSync(path.join(options.outputDirectory, "obsolete.txt"), "old output only");
  const next = produceRuntimeArtifact({
    ...options,
    runtimeVersion: "1.1.0",
    sourceCommit: "b".repeat(40),
  });
  assert.deepEqual(verifyRuntimeArtifact(options.outputDirectory, next), next);
  assert.equal(next.runtimeVersion, "1.1.0");
  assert.equal(fs.existsSync(path.join(options.outputDirectory, "obsolete.txt")), false);
  noStaging(options);
});

test("rejected candidates preserve previous artifact bytes and remove staging", async (t) => {
  const cases = [
    ["missing payload", (f) => fs.unlinkSync(path.join(f.options.bundleDirectory, "cli.mjs"))],
    [
      "unsafe inventory path",
      (f) => fs.writeFileSync(path.join(f.options.bundleDirectory, "bad name.txt"), "fixture"),
    ],
    [
      "unexpected empty directory",
      (f) => fs.mkdirSync(path.join(f.options.bundleDirectory, "empty")),
    ],
    [
      "invalid build metadata",
      (f) => fs.writeFileSync(f.buildFile, JSON.stringify({ schemaVersion: 99 })),
    ],
    ["malformed build metadata", (f) => fs.writeFileSync(f.buildFile, "{invalid-json")],
    ["oversized build metadata", (f) => fs.writeFileSync(f.buildFile, " ".repeat(1024 * 1024 + 1))],
    [
      "inherited artifact manifest",
      (f) => fs.writeFileSync(path.join(f.options.bundleDirectory, "ARTIFACT-MANIFEST.json"), "{}"),
    ],
    [
      "invalid runtime version",
      (f) => {
        f.options.runtimeVersion = "not-a-version";
      },
    ],
    [
      "invalid source revision",
      (f) => {
        f.options.sourceCommit = "short";
      },
    ],
    [
      "file-size limit",
      (f) => {
        const file = path.join(f.options.bundleDirectory, "oversized.bin");
        fs.writeFileSync(file, "");
        fs.truncateSync(file, 64 * 1024 * 1024 + 1);
      },
    ],
    [
      "inventory-count limit",
      (f) => {
        for (let index = 0; index < 4096; index++)
          fs.writeFileSync(path.join(f.options.bundleDirectory, `extra-${index}.txt`), "fixture");
      },
    ],
  ];
  for (const [name, mutate] of cases)
    await t.test(name, (t) => {
      const f = fixture(t);
      const accepted = produceRuntimeArtifact(f.options);
      const before = snapshot(f.options.outputDirectory);
      mutate(f);
      assert.throws(() => produceRuntimeArtifact(f.options));
      assert.deepEqual(snapshot(f.options.outputDirectory), before);
      assert.deepEqual(verifyRuntimeArtifact(f.options.outputDirectory, accepted), accepted);
      noStaging(f.options);
    });
});

test("copy failure preserves previous output and removes staging", (t) => {
  const { options } = fixture(t);
  produceRuntimeArtifact(options);
  const before = snapshot(options.outputDirectory);
  t.mock.method(fs, "cpSync", () => {
    throw new Error("synthetic copy failure");
  });
  assert.throws(() => produceRuntimeArtifact(options), /copy failure/);
  assert.deepEqual(snapshot(options.outputDirectory), before);
  noStaging(options);
});

test("promotion failure restores previous output and removes staging", (t) => {
  const { options } = fixture(t);
  const accepted = produceRuntimeArtifact(options);
  const before = snapshot(options.outputDirectory);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === options.outputDirectory && path.basename(from) === "candidate")
      throw new Error("synthetic promotion failure");
    return rename(from, to);
  });
  assert.throws(() => produceRuntimeArtifact(options), /promotion failed/);
  assert.deepEqual(snapshot(options.outputDirectory), before);
  assert.deepEqual(verifyRuntimeArtifact(options.outputDirectory, accepted), accepted);
  noStaging(options);
});

test("failure to move previous output leaves it untouched", (t) => {
  const { options } = fixture(t);
  produceRuntimeArtifact(options);
  const before = snapshot(options.outputDirectory);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (from === options.outputDirectory) throw new Error("synthetic backup failure");
    return rename(from, to);
  });
  assert.throws(() => produceRuntimeArtifact(options), /backup failure/);
  assert.deepEqual(snapshot(options.outputDirectory), before);
  noStaging(options);
});

test("failed restoration reports failure and retains the previous accepted artifact for recovery", (t) => {
  const { options } = fixture(t);
  const accepted = produceRuntimeArtifact(options);
  const before = snapshot(options.outputDirectory);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === options.outputDirectory) throw new Error("synthetic replacement failure");
    return rename(from, to);
  });
  assert.throws(
    () => produceRuntimeArtifact(options),
    (error) =>
      error instanceof AggregateError && /restoration failed.*retained/.test(error.message),
  );
  assert.equal(fs.existsSync(options.outputDirectory), false);
  const parent = path.dirname(options.outputDirectory);
  const staging = fs.readdirSync(parent);
  assert.equal(staging.length, 1);
  assert.match(staging[0], /^\.runtime-export-/);
  const previous = path.join(parent, staging[0], "previous");
  assert.deepEqual(snapshot(previous), before);
  assert.deepEqual(verifyRuntimeArtifact(previous, accepted), accepted);
});

test("failed first promotion leaves no output or staging", (t) => {
  const { options } = fixture(t);
  t.mock.method(fs, "renameSync", () => {
    throw new Error("synthetic promotion failure");
  });
  assert.throws(() => produceRuntimeArtifact(options), /promotion failed/);
  assert.equal(fs.existsSync(options.outputDirectory), false);
  assert.deepEqual(fs.readdirSync(path.dirname(options.outputDirectory)), []);
});

test("source and output cannot overlap", (t) => {
  const { options } = fixture(t);
  for (const outputDirectory of [
    options.bundleDirectory,
    path.join(options.bundleDirectory, "output"),
    path.dirname(options.bundleDirectory),
  ])
    assert.throws(() => produceRuntimeArtifact({ ...options, outputDirectory }), /overlap/);
});

test("production rejects links without changing previous output or link targets", async (t) => {
  for (const target of ["cli.mjs", "LICENSE", "ARTIFACT-MANIFEST.json", "output"])
    await t.test(target, (t) => {
      const f = fixture(t);
      produceRuntimeArtifact(f.options);
      const before = snapshot(f.options.outputDirectory);
      const outside = path.join(f.root, "outside.txt");
      fs.writeFileSync(outside, "unchanged fixture");
      const link =
        target === "output"
          ? path.join(f.root, "output-link")
          : path.join(f.options.bundleDirectory, target);
      if (target === "cli.mjs") fs.unlinkSync(link);
      try {
        fs.symlinkSync(
          target === "output" ? f.options.outputDirectory : outside,
          link,
          target === "output" ? "junction" : "file",
        );
      } catch (error) {
        if (process.platform === "win32" && error.code === "EPERM")
          return t.skip("File symlinks require Windows developer mode or privileges.");
        throw error;
      }
      const options = target === "output" ? { ...f.options, outputDirectory: link } : f.options;
      assert.throws(() => produceRuntimeArtifact(options));
      assert.deepEqual(snapshot(f.options.outputDirectory), before);
      assert.equal(fs.readFileSync(outside, "utf8"), "unchanged fixture");
      noStaging(f.options);
    });
});

test("manifest-size rejection preserves previous output", (t) => {
  const { options } = fixture(t);
  produceRuntimeArtifact(options);
  const before = snapshot(options.outputDirectory);
  for (let index = 0; index < 3500; index++)
    fs.writeFileSync(
      path.join(options.bundleDirectory, `${"x".repeat(220)}-${index}.txt`),
      "fixture",
    );
  assert.throws(() => produceRuntimeArtifact(options), /manifest exceeds its size limit/);
  assert.deepEqual(snapshot(options.outputDirectory), before);
  noStaging(options);
});

test("ancestor overlap rejection preserves source directories and permits a later export", (t) => {
  const { root, options } = fixture(t);
  const alias = path.join(root, "bundle-alias");
  try {
    fs.symlinkSync(options.bundleDirectory, alias, "junction");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("Directory symlinks require Windows developer mode or privileges.");
    throw error;
  }
  const accepted = produceRuntimeArtifact(options);
  const before = snapshot(options.bundleDirectory);
  const inventory = fs.readdirSync(options.bundleDirectory, { recursive: true }).sort();
  const previous = snapshot(options.outputDirectory);
  for (const parts of [["output"], ["new-parent", "output"], ["missing", "nested", "output"]]) {
    assert.throws(
      () => produceRuntimeArtifact({ ...options, outputDirectory: path.join(alias, ...parts) }),
      /overlap/,
    );
    // File hashes alone miss empty directories left behind by rejected exports.
    assert.deepEqual(
      fs.readdirSync(options.bundleDirectory, { recursive: true }).sort(),
      inventory,
    );
    assert.deepEqual(snapshot(options.bundleDirectory), before);
    assert.deepEqual(snapshot(options.outputDirectory), previous);
    assert.deepEqual(verifyRuntimeArtifact(options.outputDirectory, accepted), accepted);
    noStaging(options);
  }
  const next = produceRuntimeArtifact(options);
  assert.deepEqual(verifyRuntimeArtifact(options.outputDirectory, next), next);
  noStaging(options);
});

test("disjoint ancestor links allow missing output parents and artifact replacement", (t) => {
  const { root, options } = fixture(t);
  const destination = path.join(root, "destination");
  const alias = path.join(root, "destination-alias");
  fs.mkdirSync(destination);
  try {
    fs.symlinkSync(destination, alias, "junction");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("Directory symlinks require Windows developer mode or privileges.");
    throw error;
  }
  const before = snapshot(options.bundleDirectory);
  const aliased = { ...options, outputDirectory: path.join(alias, "new", "nested", "runtime") };
  const physical = path.join(destination, "new", "nested", "runtime");
  const first = produceRuntimeArtifact(aliased);
  assert.deepEqual(verifyRuntimeArtifact(physical, first), first);
  const next = produceRuntimeArtifact({ ...aliased, runtimeVersion: "1.1.0" });
  assert.deepEqual(verifyRuntimeArtifact(physical, next), next);
  assert.equal(next.runtimeVersion, "1.1.0");
  assert.deepEqual(snapshot(options.bundleDirectory), before);
  noStaging(aliased);
});

test("dangling output ancestors fail before any directory creation", (t) => {
  const { root, options } = fixture(t);
  const destination = path.join(root, "missing-destination");
  const alias = path.join(root, "dangling-alias");
  try {
    fs.symlinkSync(destination, alias, "junction");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM")
      return t.skip("Directory symlinks require Windows developer mode or privileges.");
    throw error;
  }
  const before = fs.readdirSync(root).sort();
  const mkdir = t.mock.method(fs, "mkdirSync", fs.mkdirSync);
  assert.throws(
    () =>
      produceRuntimeArtifact({
        ...options,
        outputDirectory: path.join(alias, "new-parent", "runtime"),
      }),
    { code: "ENOENT" },
  );
  assert.equal(mkdir.mock.callCount(), 0);
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

function committedFixture(t) {
  const f = fixture(t);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: f.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  fs.writeFileSync(path.join(f.root, "source.txt"), "committed fixture source\n");
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  fs.writeFileSync(path.join(f.root, ".gitignore"), "dist/\n");
  git("init", "--quiet");
  git("add", ".");
  // Only this disposable synthetic repository is committed; never the working checkout.
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `core.hooksPath=${path.join(f.root, "no-hooks")}`,
    "commit",
    "--quiet",
    "-m",
    "synthetic artifact provenance fixture",
  );
  f.options.sourceCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(
    f.buildFile,
    JSON.stringify({
      schemaVersion: 1,
      nodeMinimum: "24.18.0",
      nativeAddons: false,
      inputs: [
        { path: "source.txt", sha256: hash(fs.readFileSync(path.join(f.root, "source.txt"))) },
      ],
    }),
  );
  return {
    ...f,
    run: () => spawnSync(process.execPath, [exportCommand], { cwd: f.root, encoding: "utf8" }),
  };
}

test("export command joins clean-source provenance to consumer acceptance", (t) => {
  const f = committedFixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, new RegExp(`Exported runtime 1.0.0 from ${f.options.sourceCommit}`));
  const bytes = fs.readFileSync(path.join(f.options.outputDirectory, "ARTIFACT-MANIFEST.json"));
  const accepted = verifyRuntimeArtifact(f.options.outputDirectory, {
    manifestSha256: hash(bytes),
    sourceCommit: f.options.sourceCommit,
  });
  assert.equal(accepted.files, 12);
  noStaging(f.options);
});

test("export command rejects dirty source, stale inputs and invalid payload without announcing success", async (t) => {
  for (const [name, mutate] of [
    ["dirty source", (f) => fs.writeFileSync(path.join(f.root, "source.txt"), "changed fixture")],
    [
      "stale build inputs",
      (f) =>
        fs.writeFileSync(
          f.buildFile,
          JSON.stringify({ inputs: [{ path: "source.txt", sha256: "b".repeat(64) }] }),
        ),
    ],
    ["invalid payload", (f) => fs.unlinkSync(path.join(f.options.bundleDirectory, "cli.mjs"))],
  ])
    await t.test(name, (t) => {
      const f = committedFixture(t);
      assert.equal(f.run().status, 0);
      const before = snapshot(f.options.outputDirectory);
      mutate(f);
      const result = f.run();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        /clean committed source, matching build inputs and an accepted runtime payload/,
      );
      assert.ok(
        !result.stderr.includes(f.root),
        "Failure evidence must not contain private paths.",
      );
      assert.deepEqual(snapshot(f.options.outputDirectory), before);
      noStaging(f.options);
    });
});
