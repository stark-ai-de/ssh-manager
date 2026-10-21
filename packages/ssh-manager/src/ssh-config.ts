import { fault } from "./contracts.js";

export type ImportPreview = {
  profiles: { name: string; host: string; username: string; port: number }[];
  warnings: { line: number; directive: string }[];
};
const maxWarnings = 256;
/** Parse text only: never execute ProxyCommand, expand Include, read keys or silently import trust. */
export function previewSshConfig(text: string): ImportPreview {
  if (Buffer.byteLength(text) > 1024 * 1024)
    fault("LIMIT", "SSH configuration exceeds its import limit.");
  const warnings: ImportPreview["warnings"] = [];
  let omitted = 0;
  const warn = (line: number, directive: string) => {
    if (warnings.length < maxWarnings)
      warnings.push({ line, directive: directive.length > 64 ? "unknown-directive" : directive });
    else omitted++;
  };
  const blocks: { line: number; aliases: string[]; values: Record<string, string> }[] = [];
  let block: (typeof blocks)[number] | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const match = raw.trim().match(/^(\w+)(?:\s*=\s*|\s+)(.*?)(?:\s+#.*)?$/);
    if (!match) continue;
    const directive = match[1]!.toLowerCase();
    const value = match[2]!.replace(/^"(.*)"$/, "$1").trim();
    if (directive === "host") {
      const aliases = value.split(/\s+/).filter((a) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(a));
      block = { line: index + 1, aliases, values: {} };
      blocks.push(block);
      if (aliases.length !== value.split(/\s+/).length) warn(index + 1, "host-pattern");
    } else if (
      ["hostname", "user", "port", "identityfile", "proxyjump"].includes(directive) &&
      block
    ) {
      if (!(directive in block.values)) block.values[directive] = value;
    } else {
      // Match conditions are not evaluated; their directives must not extend the preceding Host.
      if (directive === "match") block = undefined;
      warn(index + 1, directive);
    }
  }
  const profiles: ImportPreview["profiles"] = [];
  for (const { line, aliases, values } of blocks)
    for (const alias of aliases) {
      const port = Number(values.port ?? 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        warn(line, "invalid-port-profile-skipped");
        continue;
      }
      profiles.push({
        name: alias,
        host: values.hostname ?? alias,
        username: values.user ?? "",
        port,
      });
      if (values.identityfile) warn(line, "identityfile-requires-explicit-credential-reference");
      if (values.proxyjump) warn(line, "proxyjump-requires-explicit-target-ids");
    }
  if (profiles.length > 256) fault("LIMIT", "Import contains too many host profiles.");
  if (omitted) warnings.splice(maxWarnings - 1, 1, { line: 0, directive: "warnings-truncated" });
  return { profiles, warnings };
}
