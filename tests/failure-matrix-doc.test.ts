import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps docs/failure-matrix.md honest: every row cites a test, every cited test exists under
 * its exact title, and no citation is left dangling. Renaming or deleting a test that the
 * public matrix relies on fails the build.
 */
const root = join(__dirname, "..");
const doc = readFileSync(join(root, "docs", "failure-matrix.md"), "utf8");

const citations = new Map<string, { file: string; title: string }>();
for (const match of doc.matchAll(/^- \*\*(T\d+)\*\* \[`([^`]+)`\]\([^)]+\) — "(.+)"$/gm)) {
  citations.set(match[1], { file: match[2], title: match[3] });
}

const rows = doc.split("\n").filter((line) => /^\| \d+\.\d+ \|/.test(line));
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("docs/failure-matrix.md", () => {
  it("has rows and citations to check", () => {
    expect(rows.length).toBeGreaterThan(50);
    expect(citations.size).toBeGreaterThan(90);
  });

  it("every row cites at least one test, and only tests that are listed", () => {
    for (const row of rows) {
      const refs = row.match(/\bT\d+\b/g) ?? [];
      expect(refs.length, row).toBeGreaterThan(0);
      for (const ref of refs) expect(citations.has(ref), `${ref} in: ${row}`).toBe(true);
    }
  });

  it("every listed test is cited by some row", () => {
    const used = new Set(rows.flatMap((row) => row.match(/\bT\d+\b/g) ?? []));
    for (const ref of citations.keys()) expect(used.has(ref), ref).toBe(true);
  });

  it.each([...citations.entries()])("%s exists under its exact title", (_ref, { file, title }) => {
    const path = join(root, file);
    expect(existsSync(path), file).toBe(true);
    const source = readFileSync(path, "utf8");
    // A test title: it("…") directly, or the title half of it.each([...])("…").
    const asTitle = new RegExp(`(?:\\bit\\(|\\]\\)\\()\\s*${escapeRegExp(JSON.stringify(title))}`);
    expect(source, `${file}: "${title}"`).toMatch(asTitle);
  });
});
