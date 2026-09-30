import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every relative link in README.md, CONTRIBUTING.md, CHANGELOG.md, SECURITY.md, CODE_OF_CONDUCT.md
 * and docs/*.md must point at a file that exists, and every
 * `#anchor` at a heading that exists (GitHub's slug rules), so the docs can't quietly rot.
 */
const root = join(__dirname, "..");
const docs = [
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)
];

/** GitHub's heading anchor: lowercase, drop punctuation except hyphens and spaces, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-");
}

function anchorsOf(markdown: string): Set<string> {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  return new Set([...withoutCode.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
}

const links = docs.flatMap((doc) => {
  const text = readFileSync(join(root, doc), "utf8").replace(/```[\s\S]*?```/g, "");
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href))
    .map((href) => ({ doc, href }));
});

describe("docs links", () => {
  it("found links to check", () => {
    expect(links.length).toBeGreaterThan(30);
  });

  it.each(links.map(({ doc, href }) => [`${doc} → ${href}`, doc, href] as const))("%s", (_label, doc, href) => {
    const [pathPart, anchor] = href.split("#");
    const target = pathPart ? join(root, dirname(doc), pathPart) : join(root, doc);
    expect(existsSync(target), `missing file ${relative(root, target)}`).toBe(true);
    if (anchor) {
      expect(statSync(target).isFile(), `${relative(root, target)} is not a file`).toBe(true);
      expect(anchorsOf(readFileSync(target, "utf8")).has(anchor), `no heading for #${anchor} in ${relative(root, target)}`).toBe(true);
    }
  });
});
