import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCatalogRoot } from "./catalog.js";
import { readRole } from "./add.js";

/** `deskmate list`: show every catalog role (• = already added to ./roles). */
export function list(cwd: string = process.cwd()): void {
  const rolesDir = join(resolveCatalogRoot(), "roles");
  const ids = readdirSync(rolesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (ids.length === 0) {
    console.log("No roles in the catalog.");
    return;
  }
  console.log("Catalog deskmates (• = added locally):\n");
  for (const id of ids) {
    const role = readRole(join(rolesDir, id));
    const mark = existsSync(join(cwd, "roles", id)) ? "•" : " ";
    console.log(`  ${mark} ${id.padEnd(18)} ${role.emoji} ${role.displayName} — ${role.summary}`);
  }
}
