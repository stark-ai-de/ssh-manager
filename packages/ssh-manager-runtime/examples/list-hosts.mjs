import path from "node:path";
import { localClient } from "../dist/launcher.js";

const [directory, ...extra] = process.argv.slice(2);
if (!directory || !path.isAbsolute(directory) || extra.length) {
  console.error(
    "Usage: node packages/ssh-manager-runtime/examples/list-hosts.mjs <absolute-private-state-directory>",
  );
  process.exitCode = 1;
} else {
  const client = await localClient("agent", { stateDirectory: directory });
  try {
    // Profile metadata may identify hosts. Keep this output private.
    console.log(JSON.stringify(await client.call("ssh_hosts_list", {}), null, 2));
  } finally {
    // Detach only this client, leaving the daemon and its SSH resources alive.
    await client.close();
  }
}
