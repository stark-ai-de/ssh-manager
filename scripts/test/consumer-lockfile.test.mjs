import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { consumerLockfile } from "../lib/consumer-lockfile.mjs";

const application = {
  lockfileVersion: "9.0",
  settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
  importers: {
    "packages/ssh-manager": {
      dependencies: { transport: { specifier: "^1.0.0", version: "1.2.3" } },
    },
    "packages/ssh-manager-runtime": {
      dependencies: { core: { specifier: "workspace:*", version: "link:../ssh-manager" } },
    },
  },
  packages: { "transport@1.2.3": { resolution: { integrity: "fixture-integrity" } } },
  snapshots: { "transport@1.2.3": {} },
};
const tarballs = [
  {
    manifest: {
      name: "core",
      version: "1.0.0",
      repository: { directory: "packages/ssh-manager" },
      dependencies: { transport: "^1.0.0" },
    },
    reference: "file:../core.tgz",
    integrity: "core-integrity",
  },
  {
    manifest: {
      name: "runtime",
      version: "1.0.0",
      repository: { directory: "packages/ssh-manager-runtime" },
      dependencies: { core: "1.0.0" },
      bin: { runtime: "dist/cli.js" },
    },
    reference: "file:../runtime.tgz",
    integrity: "runtime-integrity",
  },
];

test("consumer lock projection preserves registry versions/integrity and redirects internal edges to exact tarballs", () => {
  const source = `---\n${stringify({ lockfileVersion: "9.0", importers: {} })}---\n${stringify(application)}`;
  const result = consumerLockfile(source, tarballs);
  assert.deepEqual(result.packages["transport@1.2.3"], application.packages["transport@1.2.3"]);
  assert.equal(result.snapshots["core@file:../core.tgz"].dependencies.transport, "1.2.3");
  assert.equal(
    result.snapshots["runtime@file:../runtime.tgz"].dependencies.core,
    "file:../core.tgz",
  );
  assert.equal(result.packages["runtime@file:../runtime.tgz"].hasBin, true);
  assert.deepEqual(Object.keys(result.importers), ["."]);
  assert.equal(result.importers["."].dependencies.core.version, "file:../core.tgz");
  assert.equal(result.overrides.core, "file:../core.tgz");
});

test("consumer lock projection fails on drift rather than silently resolving a different graph", () => {
  const changed = structuredClone(tarballs);
  changed[0].manifest.dependencies.transport = "^2.0.0";
  assert.throws(() => consumerLockfile(stringify(application), changed), /specifier/);
  const peers = structuredClone(tarballs);
  peers[0].manifest.peerDependencies = { other: "*" };
  assert.throws(() => consumerLockfile(stringify(application), peers), /peer/);
  assert.throws(() => consumerLockfile("lockfileVersion: '99'", tarballs), /application/);
});
