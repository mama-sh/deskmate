import { defineConfig } from "vitest/config";

// The moved core tests live under packages/core/test/. The root vitest.config.ts
// only globs `tests/**`, so this per-package config is required to discover them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
