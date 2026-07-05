import type { TeamConfig } from "@deskmate/core";

/** The runtime driver `@deskmate/core`'s memory store loads via a dynamic import. */
export const NEON_DRIVER_PKG = "@neondatabase/serverless";

/**
 * Version range to install for the Neon serverless driver. Kept in sync with the
 * range `@deskmate/core` declares as its (optional) peer dependency in
 * `packages/core/package.json`. If you bump it there, bump it here.
 */
export const NEON_DRIVER_RANGE = "^1.1.0";

type PkgJson = Record<string, unknown>;

const DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

function depsOf(pkgJson: PkgJson, field: string): Record<string, unknown> | undefined {
  const value = pkgJson[field];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Ensure the consumer's `package.json` depends on the Neon serverless driver
 * whenever ≥1 deskmate has cross-thread memory enabled.
 *
 * `@deskmate/core` loads `@neondatabase/serverless` through a *dynamic import* and
 * declares it only as an OPTIONAL peer dependency, so a consumer who turns memory
 * on and sets `DATABASE_URL` would otherwise hit a runtime module-not-found — and
 * `eve build` can't resolve/bundle the driver. This lets `deskmate sync` add the
 * driver to the consumer's `dependencies`.
 *
 * Pure, add-only, idempotent:
 *   - No memory-enabled deskmate                    → no change.
 *   - Driver already present in ANY dep field       → no change (never duplicate,
 *     (dependencies/optional/peer)                     downgrade, or remove it).
 *   - Otherwise                                     → add it to `dependencies` at
 *                                                     NEON_DRIVER_RANGE.
 *
 * The input is never mutated: a NEW package.json object is returned (with existing
 * keys — including existing dependency entries — kept in their original order, the
 * new entry appended), alongside `changed` so the caller writes the file only when
 * something actually changed.
 */
export function ensureMemoryRuntimeDep(
  pkgJson: PkgJson,
  team: TeamConfig,
): { changed: boolean; pkgJson: PkgJson } {
  const memoryEnabled = Object.values(team.deskmates ?? {}).some((d) => d?.memory);
  if (!memoryEnabled) return { changed: false, pkgJson };

  const alreadyPresent = DEP_FIELDS.some((field) => {
    const deps = depsOf(pkgJson, field);
    return deps !== undefined && NEON_DRIVER_PKG in deps;
  });
  if (alreadyPresent) return { changed: false, pkgJson };

  const existing = depsOf(pkgJson, "dependencies") ?? {};
  const next: PkgJson = {
    ...pkgJson,
    dependencies: { ...existing, [NEON_DRIVER_PKG]: NEON_DRIVER_RANGE },
  };
  return { changed: true, pkgJson: next };
}
