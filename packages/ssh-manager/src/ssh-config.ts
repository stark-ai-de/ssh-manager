import { fault, type ProfileInput } from "./contracts.js";

export type ImportPreview = {
  profiles: ProfileInput[];
  warnings: { line: number; directive: string }[];
};
/** Parse text only: never execute ProxyCommand, expand Include, read keys or silently import trust. */
export function previewSshConfig(text: string): ImportPreview {
  if (Buffer.byteLength(text) > 1024 * 1024)
    fault("LIMIT", "SSH configuration exceeds its import limit.");
  const warnings: ImportPreview["warnings"] = [];
  const blocks: { aliases: string[]; values: Record<string, string> }[] = [];
  let block: (typeof blocks)[number] | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const match = raw.trim().match(/^([\w]+)(?:\s+|=)(.*?)(?:\s+#.*)?$/);
    if (!match) continue;
    const directive = match[1]!.toLowerCase();
    const value = match[2]!.replace(/^"(.*)"$/, "$1").trim();
    if (directive === "host") {
      const aliases = value.split(/\s+/).filter((a) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(a));
      block = { aliases, values: {} };
      blocks.push(block);
      if (aliases.length !== value.split(/\s+/).length)
        warnings.push({ line: index + 1, directive: "host-pattern" });
    } else if (
      ["hostname", "user", "port", "identityfile", "proxyjump"].includes(directive) &&
      block
    ) {
      if (!(directive in block.values)) block.values[directive] = value;
    } else warnings.push({ line: index + 1, directive });
  }
  const profiles: ProfileInput[] = [];
  for (const { aliases, values } of blocks)
    for (const alias of aliases) {
      const port = Number(values.port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        warnings.push({ line: 0, directive: "invalid-port-profile-skipped" });
        continue;
      }
      profiles.push({
        name: alias,
        host: values.hostname ?? alias,
        username: values.user ?? "",
        port,
      });
      if (values.identityfile)
        warnings.push({
          line: 0,
          directive: "identityfile-requires-explicit-credential-reference",
        });
      if (values.proxyjump)
        warnings.push({ line: 0, directive: "proxyjump-requires-explicit-target-ids" });
    }
  if (profiles.length > 256) fault("LIMIT", "Import contains too many host profiles.");
  return { profiles, warnings };
}
