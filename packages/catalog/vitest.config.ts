import { defineConfig } from "vitest/config";

// The relocated role tool-logic tests live under packages/catalog/test/. The root
// vitest.config.ts only globs `tests/**`, so this per-package config is required to
// discover them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
