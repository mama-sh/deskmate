import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a directory that contains the catalog `roles/`.
 *
 * Two layouts are supported, tried in order:
 *   1. Bundled — the published `deskmate` CLI ships the catalog as a `catalog/`
 *      dir next to the built module (e.g. `dist/catalog`, copied in by the CLI
 *      `build` script and included via package.json `files`).
 *   2. In-workspace — this repo's sibling `packages/catalog` (the dev fallback,
 *      used when running from `src` where no bundled copy exists).
 *
 * Returns the first candidate that actually contains `roles/`. Pure: depends
 * only on this module's location + the filesystem (no cwd, no argv).
 */
export function resolveCatalogRoot(): string {
  const candidates = [
    resolve(HERE, "catalog"), // bundled next to the built module (dist/catalog)
    resolve(HERE, "..", "..", "catalog"), // workspace sibling: packages/catalog
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "roles"))) return dir;
  }
  throw new Error(
    `Could not locate the deskmate catalog (looked for a roles/ dir in: ${candidates.join(", ")}).`,
  );
}
