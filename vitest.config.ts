import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  // Lets examples import "corrobo" exactly as a user would, resolved to this repo's source
  // (tsconfig.json "paths" does the same for tsx and the editor).
  resolve: {
    alias: [
      { find: /^corrobo\/postgres$/, replacement: src("stores/postgres.ts") },
      { find: /^corrobo\/testing$/, replacement: src("testing/index.ts") },
      { find: /^corrobo$/, replacement: src("core/index.ts") }
    ]
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
    // The Postgres-backed test files share one physical scratch database and TRUNCATE it
    // around their tests. Running test files in parallel let two files' TRUNCATEs and
    // inserts interleave and stomp on each other — a shared-fixture problem, not a bug in
    // the code under test. Sequential file execution keeps that isolated.
    fileParallelism: false
  }
});
