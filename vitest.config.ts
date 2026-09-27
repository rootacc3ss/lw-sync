import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // The obsidian package ships only types (no runtime entry). Unit tests stub it.
    alias: {
      obsidian: fileURLToPath(
        new URL("./test/helpers/obsidian-mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
