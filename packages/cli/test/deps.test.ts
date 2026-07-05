import { describe, expect, it } from "vitest";
import type { TeamConfig } from "@deskmate/core";
import { ensureMemoryRuntimeDep, NEON_DRIVER_PKG, NEON_DRIVER_RANGE } from "../src/sync/deps.js";

// `ensureMemoryRuntimeDep` is the pure guard behind `deskmate sync`'s package.json
// step: it decides whether the consumer needs `@neondatabase/serverless` added.
// A memory-enabled deskmate carries a parsed `{ maxItems, coreLimit }`; a disabled
// one is `undefined` (see core's config transform). These tests pass hand-built
// team shapes with just the `deskmates.*.memory` field the helper reads.

const memoryTeam = {
  deskmates: {
    product_analyst: { memory: { maxItems: 200, coreLimit: 25 } },
    devops: {},
  },
} as unknown as TeamConfig;

const noMemoryTeam = {
  deskmates: {
    devops: {},
    product_analyst: {},
  },
} as unknown as TeamConfig;

describe("ensureMemoryRuntimeDep", () => {
  it("adds the Neon driver to dependencies when a deskmate has memory and it is absent", () => {
    const pkg = { name: "consumer", dependencies: { eve: "^0.19.0" } };
    const { changed, pkgJson } = ensureMemoryRuntimeDep(pkg, memoryTeam);
    expect(changed).toBe(true);
    const deps = pkgJson.dependencies as Record<string, string>;
    expect(deps[NEON_DRIVER_PKG]).toBe(NEON_DRIVER_RANGE);
    // Existing deps are preserved (and kept ahead of the appended entry).
    expect(deps.eve).toBe("^0.19.0");
    expect(Object.keys(deps)).toEqual(["eve", NEON_DRIVER_PKG]);
    // The input object is never mutated.
    expect(NEON_DRIVER_PKG in pkg.dependencies).toBe(false);
  });

  it("creates a dependencies block when the package.json has none", () => {
    const pkg = { name: "consumer" };
    const { changed, pkgJson } = ensureMemoryRuntimeDep(pkg, memoryTeam);
    expect(changed).toBe(true);
    expect((pkgJson.dependencies as Record<string, string>)[NEON_DRIVER_PKG]).toBe(NEON_DRIVER_RANGE);
  });

  it("is a no-op when the driver is already in dependencies (idempotent)", () => {
    const pkg = { name: "consumer", dependencies: { [NEON_DRIVER_PKG]: "^1.0.0" } };
    const { changed, pkgJson } = ensureMemoryRuntimeDep(pkg, memoryTeam);
    expect(changed).toBe(false);
    // Never downgraded or overwritten — the existing range stays put.
    expect((pkgJson.dependencies as Record<string, string>)[NEON_DRIVER_PKG]).toBe("^1.0.0");
    expect(pkgJson).toBe(pkg);
  });

  it("does not duplicate when the driver is declared as a peer/optional dependency", () => {
    for (const field of ["peerDependencies", "optionalDependencies"] as const) {
      const pkg = { name: "consumer", [field]: { [NEON_DRIVER_PKG]: "^1.1.0" }, dependencies: {} };
      const { changed, pkgJson } = ensureMemoryRuntimeDep(pkg, memoryTeam);
      expect(changed).toBe(false);
      expect(NEON_DRIVER_PKG in (pkgJson.dependencies as object)).toBe(false);
    }
  });

  it("does nothing when no deskmate has memory enabled", () => {
    const pkg = { name: "consumer", dependencies: { eve: "^0.19.0" } };
    const { changed, pkgJson } = ensureMemoryRuntimeDep(pkg, noMemoryTeam);
    expect(changed).toBe(false);
    expect(NEON_DRIVER_PKG in (pkgJson.dependencies as object)).toBe(false);
  });
});
