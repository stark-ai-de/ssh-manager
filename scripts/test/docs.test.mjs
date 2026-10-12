import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkDocumentation } from "../lib/repository-docs.mjs";

function fixture(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-docs-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(content)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), value);
  }
  return { root, files: Object.keys(content) };
}

test("documentation checks resolve local references, heading slugs and duplicate anchors without networking", (t) => {
  const f = fixture(t, {
    "README.md":
      "# Start\n\n[guide][guide]\n\n[guide]: docs/guide.md#hello-world-1\n\n[external](https://example.invalid/not-fetched)\n![asset](image.svg)\n```md\n[ignored](missing.md)\n```\n",
    "docs/guide.md": "# Hello `world`\n\n## Hello world\n\n[home](../README.md#start)\n",
    "image.svg": "<svg></svg>",
    "config.yml": "---\nenabled: true\n---\nsecond: valid\n",
  });
  assert.deepEqual(checkDocumentation(f.root, f.files), []);
});

test("documentation checks reject missing paths/anchors, traversal, invalid JSON and duplicate YAML keys", (t) => {
  const f = fixture(t, {
    "README.md":
      "# Start\n\n[missing](missing.md)\n[anchor](#no-such-heading)\n[escape](../outside)\n```json\n{broken}\n```\n",
    "config.yml": "---\nfirst: valid\n---\nkey: first\nkey: second\n",
  });
  const errors = checkDocumentation(f.root, f.files);
  for (const message of [
    "missing local link",
    "missing Markdown heading",
    "escapes repository",
    "invalid fenced JSON",
    "invalid YAML",
  ])
    assert.ok(
      errors.some((error) => error.includes(message)),
      message,
    );
});
