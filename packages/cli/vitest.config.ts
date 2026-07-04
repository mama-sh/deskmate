import { defineConfig } from "vitest/config";

// The CLI's unit tests (pure helpers: env, mcp-template, config-file, catalog)
// live under packages/cli/test/. This per-package config discovers them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
