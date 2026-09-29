import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The README quickstart must be real, runnable code: it is the `#region readme` block of
 * examples/quickstart/quickstart.ts, verbatim, and that file must print what the README says.
 */
const root = join(__dirname, "..");
const source = readFileSync(join(root, "examples", "quickstart", "quickstart.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

const region = source.split("// #region readme\n")[1]?.split("// #endregion")[0]?.trimEnd();

describe("README quickstart", () => {
  it("is the #region readme block of examples/quickstart/quickstart.ts, verbatim", () => {
    expect(region, "region markers missing").toBeTruthy();
    expect(readme).toContain("```ts\n" + region + "\n```");
  });

  it("imports only from the published package name", () => {
    expect(region).toMatch(/from "corrobo"/);
    expect(region).not.toMatch(/from "\.\.?\//);
  });

  it("prints what the README says it prints", async () => {
    const { stdout } = await promisify(execFile)("npx", ["tsx", "examples/quickstart/quickstart.ts"], { cwd: root });
    expect(stdout).toBe("APPLIED COMPLETE\nrefunds made: 1\n");
  }, 30_000);
});
