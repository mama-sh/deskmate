import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a directory that contains the catalog `roles/`.
 *
 * Two layouts are supported, tried in order:
 *   1. Bundled — the published `deskmate` CLI ships the catalog content as a
 *      sibling `catalog/` dir next to its sources (packages/cli/catalog).
 *   2. In-workspace — this repo's sibling `packages/catalog`.
 *
 * Returns the first candidate that actually contains `roles/`. Pure: depends
 * only on this module's location + the filesystem (no cwd, no argv).
 */
export function resolveCatalogRoot(): string {
  const candidates = [
    resolve(HERE, "..", "catalog"), // bundled inside the published CLI
    resolve(HERE, "..", "..", "catalog"), // workspace sibling: packages/catalog
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "roles"))) return dir;
  }
  throw new Error(
    `Could not locate the deskmate catalog (looked for a roles/ dir in: ${candidates.join(", ")}).`,
  );
}
