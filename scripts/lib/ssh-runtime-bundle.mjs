import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { runtimeArtifactFormat } from "./ssh-runtime-artifact.mjs";

const packages = ["ssh-manager", "ssh-manager-runtime", "ssh-manager-mcp"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function dependencyManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("Dependency package metadata could not be read as valid JSON.");
  }
}
export function runtimeSourceFiles(root) {
  const files = [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/lib/ssh-runtime-bundle.mjs",
    "scripts/lib/ssh-runtime-artifact.mjs",
  ];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime source may not contain symbolic links.");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error("Runtime source must contain regular files.");
    }
  }
  for (const name of packages) {
    files.push(`packages/${name}/package.json`, `packages/${name}/tsconfig.json`);
    walk(`packages/${name}/src`);
  }
  walk("packages/ssh-manager-runtime/viewer");
  return files.sort();
}
export function buildRuntimeBundle({ root, output, dependencyRoot = root }) {
  if (
    sha256(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))) !==
    sha256(fs.readFileSync(path.join(dependencyRoot, "pnpm-lock.yaml")))
  )
    throw new Error("Runtime build dependencies must use the candidate's exact lockfile.");
  const inputs = runtimeSourceFiles(root).map((file) => ({
    path: file,
    sha256: sha256(fs.readFileSync(path.join(root, file))),
  }));
  fs.mkdirSync(output, { recursive: true });
  const dependencies = new Map();
  const entrySources = {};
  const entryPoints = {
    "mcp.mjs": "packages/ssh-manager-mcp/src/main.ts",
    "daemon.mjs": "packages/ssh-manager-runtime/src/daemon.ts",
    "cli.mjs": "packages/ssh-manager-runtime/src/cli.ts",
  };
  // Bundle canonical sources directly: a projection must never depend on stale dist/ files.
  const alias = {
    "@stark-ai/ssh-manager": path.join(root, "packages/ssh-manager/src/index.ts"),
    "@stark-ai/ssh-manager/contracts": path.join(root, "packages/ssh-manager/src/contracts.ts"),
    ...Object.fromEntries(
      ["client", "catalog", "launcher"].map((name) => [
        `@stark-ai/ssh-manager-runtime/${name}`,
        path.join(root, `packages/ssh-manager-runtime/src/${name}.ts`),
      ]),
    ),
  };
  for (const [name, entry] of Object.entries(entryPoints)) {
    const result = buildSync({
      absWorkingDir: root,
      entryPoints: [entry],
      outfile: path.join(output, name),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: false,
      alias,
      nodePaths: packages.map((name) =>
        path.join(dependencyRoot, "packages", name, "node_modules"),
      ),
      minify: true,
      legalComments: "inline",
      metafile: true,
      logLevel: "silent",
      external: ["cpu-features", "./crypto/build/Release/sshcrypto.node"],
      banner: {
        js: 'import { createRequire as __bundleCreateRequire } from "node:module"; import { fileURLToPath as __bundleFileURLToPath } from "node:url"; import { dirname as __bundleDirname } from "node:path"; const require = __bundleCreateRequire(import.meta.url); const __filename = __bundleFileURLToPath(import.meta.url); const __dirname = __bundleDirname(__filename);',
      },
    });
    entrySources[name] = Object.keys(result.metafile.inputs)
      .filter((input) => !input.includes("node_modules/"))
      .map((input) => path.relative(root, path.resolve(root, input)).split(path.sep).join("/"))
      .sort();
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.includes("node_modules/")) continue;
      let directory = path.dirname(path.resolve(root, input));
      while (
        directory !== path.dirname(directory) &&
        !fs.existsSync(path.join(directory, "package.json"))
      )
        directory = path.dirname(directory);
      if (!fs.existsSync(path.join(directory, "package.json"))) continue;
      const manifest = dependencyManifest(path.join(directory, "package.json"));
      if (!manifest.name || manifest.name.startsWith("@stark-ai/")) continue;
      const licenses = fs
        .readdirSync(directory)
        .filter((file) => /^(?:license|licence|copying)(?:\.|$)/i.test(file))
        .filter((file) => fs.statSync(path.join(directory, file)).isFile());
      dependencies.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        license:
          manifest.license ??
          manifest.licenses?.map((item) => item.type).join(" AND ") ??
          "SEE LICENSE",
        text: licenses
          .map((file) => fs.readFileSync(path.join(directory, file), "utf8"))
          .join("\n"),
      });
    }
  }
  const viewer = path.join(output, "viewer");
  fs.mkdirSync(viewer, { recursive: true });
  fs.cpSync(path.join(root, "packages/ssh-manager-runtime/viewer"), viewer, { recursive: true });
  const require = createRequire(
    path.join(dependencyRoot, "packages/ssh-manager-runtime/package.json"),
  );
  for (const [name, source] of [
    ["xterm.js", "@xterm/xterm/lib/xterm.js"],
    ["xterm.css", "@xterm/xterm/css/xterm.css"],
    ["fit.js", "@xterm/addon-fit/lib/addon-fit.js"],
  ]) {
    const file = require.resolve(source);
    fs.copyFileSync(file, path.join(viewer, name));
    const manifest = dependencyManifest(path.join(path.dirname(file), "../package.json"));
    const directory = path.resolve(path.dirname(file), "..");
    dependencies.set(`${manifest.name}@${manifest.version}`, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      text: fs.readFileSync(path.join(directory, "LICENSE"), "utf8"),
    });
  }
  const sorted = [...dependencies.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(
    path.join(output, "NOTICE.txt"),
    sorted
      .map((d) => `${d.name}@${d.version} (${d.license})\n${d.text}`)
      .join("\n\n----------------\n\n"),
  );
  fs.writeFileSync(
    path.join(output, "BUILD-MANIFEST.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        nodeMinimum: runtimeArtifactFormat.nodeMinimum,
        nativeAddons: false,
        inputs,
        entrySources,
        dependencies: sorted.map((dependency) => ({
          name: dependency.name,
          version: dependency.version,
          license: dependency.license,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  return output;
}
