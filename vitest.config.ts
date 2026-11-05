import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Conversations live only in PostgreSQL, so the tests need one; see test/postgres.ts.
    globalSetup: ["./test/postgres.ts"],
  },
});
