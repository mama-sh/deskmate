// Cross-platform post-build for the `deskmate` CLI (replaces a POSIX shell chain of
// chmod/rm/mkdir/cp so `pnpm -r build` works on Windows too). Paths are resolved
// relative to this script's location — not process.cwd() — so it behaves the same
// however pnpm invokes it.
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgDir, "dist", "cli.js");
const catalogDest = join(pkgDir, "dist", "catalog");
const rolesSrc = join(pkgDir, "..", "catalog", "roles");

// Make the bin executable. Best-effort: platforms without exec bits (Windows) just
// no-op, so a failure here must not fail the build.
try {
  chmodSync(cli, 0o755);
} catch (err) {
  console.warn(`postbuild: could not chmod ${cli} (${err?.message ?? err}) — continuing.`);
}

// Rebuild dist/catalog/roles from the workspace catalog, replacing any prior copy.
rmSync(catalogDest, { recursive: true, force: true });
mkdirSync(catalogDest, { recursive: true });
cpSync(rolesSrc, join(catalogDest, "roles"), { recursive: true });
