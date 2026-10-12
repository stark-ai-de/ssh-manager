import fs from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import GithubSlugger from "github-slugger";
import { parseAllDocuments } from "yaml";

const markdown = new MarkdownIt();
function parseMarkdown(text) {
  const tokens = markdown.parse(text, {});
  const slugger = new GithubSlugger();
  const headings = new Set();
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].type !== "heading_open") continue;
    const inline = tokens[index + 1];
    const title = (inline.children ?? [])
      .filter((token) => ["text", "code_inline", "image"].includes(token.type))
      .map((token) => token.content)
      .join("");
    headings.add(slugger.slug(title));
  }
  return { tokens, headings };
}

/** Offline checks only: external links are intentionally not fetched by normal validation. */
export function checkDocumentation(root, files) {
  const errors = [];
  const cache = new Map();
  const parsed = (file) => {
    if (!cache.has(file)) cache.set(file, parseMarkdown(fs.readFileSync(file, "utf8")));
    return cache.get(file);
  };
  const absoluteRoot = path.resolve(root);
  for (const relative of files.filter((file) => /\.(?:md|ya?ml)$/.test(file))) {
    const file = path.resolve(absoluteRoot, relative);
    if (/\.ya?ml$/.test(file)) {
      // pnpm 12 lockfiles legitimately contain more than one YAML document.
      for (const document of parseAllDocuments(fs.readFileSync(file, "utf8")))
        for (const error of document.errors)
          errors.push(`${relative}: invalid YAML: ${error.code}`);
      continue;
    }
    const { tokens } = parsed(file);
    for (const token of tokens) {
      if (token.type === "fence" && token.info.trim() === "json") {
        try {
          JSON.parse(token.content);
        } catch {
          errors.push(`${relative}: invalid fenced JSON example`);
        }
      }
      for (const child of token.children ?? []) {
        const link =
          child.type === "link_open"
            ? child.attrGet("href")
            : child.type === "image"
              ? child.attrGet("src")
              : undefined;
        if (!link || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(link)) continue;
        try {
          const [location, fragment] = link.split("#", 2);
          const decoded = decodeURIComponent(location.split("?")[0]);
          const destination = decoded ? path.resolve(path.dirname(file), decoded) : file;
          const within = path.relative(absoluteRoot, destination);
          if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
            throw new Error("local link escapes repository");
          if (!fs.existsSync(destination)) throw new Error("missing local link target");
          if (
            fragment &&
            destination.endsWith(".md") &&
            !parsed(destination).headings.has(decodeURIComponent(fragment))
          )
            throw new Error("missing Markdown heading anchor");
        } catch (error) {
          errors.push(`${relative}: ${error.message}: ${link}`);
        }
      }
    }
  }
  return errors;
}
