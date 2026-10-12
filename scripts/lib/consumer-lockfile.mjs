import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

/** Reuse the reviewed registry graph, replacing only workspace roots with packed tarballs.
 * A frozen source install need not cache registry metadata for a new resolution.
 * This projection lets the consumer install stay offline without resolving new versions.
 */
export function consumerLockfile(source, tarballs) {
  const documents = parseAllDocuments(source).map((document) => {
    assert.equal(document.errors.length, 0, "Source lockfile must parse.");
    return document.toJS();
  });
  const candidates = documents.filter((document) => document?.importers?.["packages/ssh-manager"]);
  assert.equal(candidates.length, 1, "Expected one application dependency lockfile document.");
  const lock = structuredClone(candidates[0]);
  assert.equal(lock.lockfileVersion, "9.0");
  assert.ok(lock.packages && lock.snapshots);
  const overrides = Object.fromEntries(
    tarballs.map(({ manifest, reference }) => [manifest.name, reference]),
  );
  const importer = { dependencies: {} };
  for (const { manifest, reference, integrity } of tarballs) {
    assert.ok(
      !manifest.peerDependencies && !manifest.optionalDependencies,
      "Extend the consumer lock projection before adding workspace peer/optional dependencies.",
    );
    const sourceImporter = lock.importers[manifest.repository.directory];
    assert.ok(sourceImporter, "Packed package must match a canonical source importer.");
    const dependencies = {};
    for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
      const original = sourceImporter.dependencies?.[name];
      assert.ok(original, "Packed dependency must exist in the reviewed source lockfile.");
      if (name in overrides) dependencies[name] = overrides[name];
      else {
        assert.equal(
          original.specifier,
          specifier,
          "Packed dependency specifier differs from the source lockfile.",
        );
        dependencies[name] = original.version;
      }
    }
    assert.equal(
      Object.keys(dependencies).length,
      Object.keys(sourceImporter.dependencies ?? {}).length,
    );
    const key = `${manifest.name}@${reference}`;
    lock.packages[key] = {
      resolution: { integrity, tarball: reference },
      version: manifest.version,
      ...(manifest.engines ? { engines: manifest.engines } : {}),
      ...(manifest.bin ? { hasBin: true } : {}),
    };
    lock.snapshots[key] = { dependencies };
    importer.dependencies[manifest.name] = { specifier: reference, version: reference };
  }
  lock.overrides = overrides;
  lock.importers = { ".": importer };
  return lock;
}
