import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const [file, flag, callable] of [
  [
    "packages/ssh-manager-runtime/dist/cli.js",
    "supportsScopedManagementCli",
    "runManagementCliOperation",
  ],
  [
    "packages/ssh-manager-mcp/dist/main.js",
    "supportsScopedManagementStdio",
    "serveManagementStdio",
  ],
  ["dist/ssh-runtime/cli.mjs", "supportsScopedManagementCli", "runManagementCliOperation"],
  ["dist/ssh-runtime/mcp.mjs", "supportsScopedManagementStdio", "serveManagementStdio"],
]) {
  test(`${file}: file, stdin and eval imports never start the entrypoint or resolve argv paths`, (t) => {
    const temporary = mkdtempSync(path.join(tmpdir(), "ssh-import-check-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const source = `import assert from 'node:assert/strict';
      const entry = await import(${JSON.stringify(pathToFileURL(path.resolve(file)).href)});
      assert.equal(entry.${flag}, true);
      assert.equal(typeof entry.${callable}, 'function');
      console.log('imported');`;
    const wrapper = path.join(temporary, "wrapper.mjs");
    writeFileSync(wrapper, source);
    for (const [args, input] of [
      [[wrapper]],
      [["--input-type=module", "-"], source],
      [["--input-type=module", "-e", source]],
      [["--input-type=module", "-e", `process.argv[1] = 'missing-entrypoint';\n${source}`]],
    ]) {
      const result = spawnSync(process.execPath, args, { input, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(result.stdout.trim(), "imported");
      assert.equal(result.stderr, "");
    }
  });
}

for (const file of ["packages/ssh-manager-runtime/dist/cli.js", "dist/ssh-runtime/cli.mjs"]) {
  test(`${file}: direct invocation still runs CLI help without starting a daemon`, () => {
    const result = spawnSync(process.execPath, [file, "help"], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ssh-management start/);
    assert.match(result.stdout, /ssh_grants_set/);
  });
}
