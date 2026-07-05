import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTeam, type TeamConfig } from "@deskmate/core";

export const CONFIG_FILE = "deskmate.config.ts";

/**
 * Load + validate the consumer's `deskmate.config.ts`. Mirrors `syncCommand`'s
 * dynamic import (needs Node ≥23.6 native type-stripping, or
 * `node --experimental-strip-types`).
 */
export async function loadTeam(cwd: string): Promise<TeamConfig> {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILE} found in ${cwd}. Run \`deskmate add <id>\` first.`);
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not load ${CONFIG_FILE} (${reason}). Loading a .ts config needs Node ≥23.6 ` +
        `(native type-stripping) or \`node --experimental-strip-types\`.`,
    );
  }
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`${CONFIG_FILE} must \`export default\` a team config object.`);
  }
  return defineTeam(mod.default);
}
