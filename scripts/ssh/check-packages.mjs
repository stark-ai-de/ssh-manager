import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { consumerLockfile } from "../lib/consumer-lockfile.mjs";

const packages = ["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"];
const root = process.cwd();
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this check through pnpm pack:check.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-package-check-"));
// npm_execpath can be pnpm's JS entrypoint or its standalone native executable.
const jsEntry = /\.[cm]?js$/i.test(pnpm);
const runPnpm = (args, cwd = root) =>
  execFileSync(jsEntry ? process.execPath : pnpm, [...(jsEntry ? [pnpm] : []), ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
try {
  runPnpm(["--filter", "./packages/*", "-r", "pack", "--pack-destination", temporary]);
  const archives = fs.readdirSync(temporary).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, packages.length);
  const dependencies = {};
  const tarballs = [];
  const versions = Object.fromEntries(
    packages.map((name) => {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "packages", name, "package.json")),
      );
      return [manifest.name, manifest.version];
    }),
  );
  for (const archive of archives) {
    const file = path.join(temporary, archive);
    const members = execFileSync("tar", ["-tzf", file], { encoding: "utf8" }).trim().split(/\r?\n/);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", file, "package/package.json"], { encoding: "utf8" }),
    );
    assert.ok(manifest.name in versions);
    assert.equal(manifest.version, versions[manifest.name]);
    assert.ok(members.includes("package/README.md"));
    assert.ok(members.includes("package/dist/LICENSE"));
    for (const member of members) {
      assert.ok(!member.includes("\\") && !member.split("/").includes(".."));
      assert.match(
        member,
        /^package\/(?:package\.json|README\.md|dist\/(?:[a-z-]+(?:\.js|\.d\.ts)|LICENSE)|viewer\/(?:index\.html|viewer\.(?:js|css)))$/,
      );
    }
    const paths = (value) =>
      typeof value === "string" ? [value] : Object.values(value ?? {}).flatMap(paths);
    for (const target of [...paths(manifest.exports), ...paths(manifest.bin)])
      assert.ok(
        members.includes(`package/${target.replace(/^\.\//, "")}`),
        "Package entrypoint must be shipped.",
      );
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      assert.ok(
        !version.startsWith("workspace:"),
        "Packed dependencies must not retain workspace protocols.",
      );
      if (name in versions) assert.equal(version, versions[name]);
    }
    assert.equal(manifest.repository.url, "git+https://github.com/stark-ai-de/ssh-manager.git");
    assert.equal(manifest.license, "Apache-2.0");
    dependencies[manifest.name] = `file:../${archive}`;
    tarballs.push({
      manifest,
      reference: dependencies[manifest.name],
      integrity: "sha512-" + createHash("sha512").update(fs.readFileSync(file)).digest("base64"),
    });
  }
  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  // Before registry publication, transitive internal dependencies must also resolve
  // to these exact local tarballs rather than looking up their concrete versions.
  fs.writeFileSync(
    path.join(consumer, "pnpm-workspace.yaml"),
    JSON.stringify({ overrides: dependencies }),
  );
  fs.writeFileSync(
    path.join(consumer, "pnpm-lock.yaml"),
    stringify(
      consumerLockfile(fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), tarballs),
    ),
  );
  // Policy verification belongs to the normal source install. This disposable
  // projection preserves that exact registry graph; do not require uncached
  // registry policy metadata again, and never relax the source workspace policy.
  // A temporary consumer can be on another Windows drive or outside a
  // workspace-local store configuration. Reuse the source install's store.
  const sourceStore = runPnpm(["store", "path"]).trim();
  assert.ok(path.isAbsolute(sourceStore), "pnpm must report an absolute store path.");
  runPnpm(
    [
      "install",
      "--store-dir",
      sourceStore,
      "--offline",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--ignore-scripts",
    ],
    consumer,
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { SSHManager } from '@stark-ai/ssh-manager';
    import { ManagementClient } from '@stark-ai/ssh-manager-runtime/client';
    import { runManagementCliOperation, supportsScopedManagementCli } from '@stark-ai/ssh-manager-runtime/cli';
    import { createMcpServer } from '@stark-ai/ssh-manager-mcp';
    assert.equal(typeof SSHManager, 'function');
    assert.equal(typeof ManagementClient, 'function');
    assert.equal(typeof createMcpServer, 'function');
    assert.equal(supportsScopedManagementCli, true);
    assert.equal(typeof runManagementCliOperation, 'function');
    assert.deepEqual(await runManagementCliOperation('ssh_hosts_list', {}, {
      client: new ManagementClient('http://127.0.0.1:1', 'b'.repeat(43)),
      invoke: async (operation, args) => ({ operation, args }),
    }), { operation: 'ssh_hosts_list', args: {} });
  `,
    ],
    { cwd: consumer, stdio: "pipe", timeout: 30000 },
  );
  const typeFixture = path.join(consumer, "cli-types.mts");
  fs.writeFileSync(
    typeFixture,
    `
    import { ManagementClient } from '@stark-ai/ssh-manager-runtime/client';
    import { runManagementCliOperation, supportsScopedManagementCli } from '@stark-ai/ssh-manager-runtime/cli';
    const supported: boolean = supportsScopedManagementCli;
    declare const client: ManagementClient;
    const result: Promise<unknown> = runManagementCliOperation('ssh_hosts_list', {}, { client });
    // @ts-expect-error the installed declaration retains canonical operation names
    runManagementCliOperation('not_an_operation', {}, { client });
    void supported; void result;
  `,
  );
  execFileSync(
    process.execPath,
    [
      path.join(root, "packages/ssh-manager-runtime/node_modules/typescript/lib/tsc.js"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      typeFixture,
    ],
    { cwd: consumer, stdio: "pipe", timeout: 30000 },
  );
  console.log(
    "Packages: three tarball inventories, entrypoints, metadata, offline consumer imports and CLI declarations passed; nothing published or connected.",
  );
} catch (error) {
  // Keep machine-local paths and tool output out of the public evidence line.
  console.error(
    "Package check failed. Rebuild first and ensure pnpm's offline store and the tar utility are available.",
  );
  throw error;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
