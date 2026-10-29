import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/repo/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
  },
});
