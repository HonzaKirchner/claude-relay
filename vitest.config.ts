import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test runs real git and node child processes, which a busy machine slows down.
    testTimeout: 30_000,
  },
});
