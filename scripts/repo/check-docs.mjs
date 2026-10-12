import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { checkDocumentation } from "../lib/repository-docs.mjs";

// Include new non-ignored files before they are staged, just like the reference repository's checks.
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    }).split("\0"),
  ),
].filter((file) => file && fs.existsSync(file));
const errors = checkDocumentation(process.cwd(), files);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Documentation: local Markdown links/anchors, fenced JSON examples and YAML syntax passed (external links not fetched).",
  );
}
