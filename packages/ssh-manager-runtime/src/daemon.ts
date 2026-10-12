import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createRuntime } from "./server.js";
import { defaultStateDirectory } from "./launcher.js";

export async function runDaemon() {
  const index = process.argv.indexOf("--state-directory");
  const directory = index === -1 ? defaultStateDirectory() : path.resolve(process.argv[index + 1]!);
  const require = createRequire(import.meta.url);
  const bundled = fs.existsSync(fileURLToPath(new URL("./viewer/index.html", import.meta.url)));
  const viewerDirectory = fileURLToPath(
    new URL(bundled ? "./viewer/" : "../viewer/", import.meta.url),
  );
  const marker = path.join(directory, "runtime.json");
  const runtime = await createRuntime({
    stateDirectory: directory,
    viewerDirectory,
    assets: bundled
      ? {
          "/xterm.js": path.join(viewerDirectory, "xterm.js"),
          "/xterm.css": path.join(viewerDirectory, "xterm.css"),
          "/fit.js": path.join(viewerDirectory, "fit.js"),
        }
      : {
          "/xterm.js": require.resolve("@xterm/xterm/lib/xterm.js"),
          "/xterm.css": require.resolve("@xterm/xterm/css/xterm.css"),
          "/fit.js": require.resolve("@xterm/addon-fit/lib/addon-fit.js"),
        },
    onClose: () => {
      try {
        if (JSON.parse(fs.readFileSync(marker, "utf8")).pid === process.pid) fs.unlinkSync(marker);
      } catch {
        /* Preserve another runtime's marker. */
      }
    },
  });
  const temporary = path.join(directory, `.runtime-${process.pid}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify({ schema: 1, url: runtime.url, pid: process.pid }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, marker);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const close = () => {
    void runtime.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
void runDaemon().catch(() => {
  console.error(
    "SSH management daemon failed to start; inspect the local state ownership and Node version.",
  );
  process.exitCode = 1;
});
