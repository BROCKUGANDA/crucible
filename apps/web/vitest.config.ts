import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest needs JSX compiled; the app's tsconfig sets `jsx: preserve` because
 * Next compiles it. esbuild handles it here.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
