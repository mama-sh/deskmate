import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TeamConfig } from "@deskmate/core";
import { planSync } from "./plan.js";

export const CONFIG_FILE = "deskmate.config.ts";

/**
 * `deskmate sync`: read the consumer's `deskmate.config.ts` and (re)generate the
 * entire `agent/**` tree Eve discovers at build time. `sync` OWNS `agent/**` — it
 * can rebuild it from scratch from the config + the authored `roles/<id>/` files.
 *
 * The config is loaded via dynamic `import()`. Importing a `.ts` module directly
 * requires Node ≥23.6 (native type-stripping) or the `--experimental-strip-types`
 * flag; on older Node the import throws and we surface that hint. (The generated
 * tree itself targets Node 24 — see the root package.json `engines`.)
 */
export async function syncCommand(cwd: string = process.cwd()): Promise<void> {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILE} found in ${cwd}. Run \`deskmate add <id>\` first.`);
  }

  let team: TeamConfig;
  try {
    const mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
    team = mod.default as TeamConfig;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not load ${CONFIG_FILE} (${reason}). Loading a .ts config needs Node ≥23.6 ` +
        `(native type-stripping) or \`node --experimental-strip-types\`.`,
    );
  }
  if (!team || typeof team !== "object") {
    throw new Error(`${CONFIG_FILE} must \`export default defineTeam({ … })\`.`);
  }

  const plan = planSync(team, cwd);

  // `sync` OWNS each surviving deskmate's generated subtree: wipe it before writing
  // so a tool/skill/connection removed from the authored `roles/<id>/` can't leave a
  // dangling generated shim behind (a stale shim imports a now-missing file and
  // breaks `eve build`). The planned writes below recreate the subtree fresh. Only
  // ever touches generated `agent/**` — the authored `roles/**` is never removed.
  for (const id of Object.keys(team.deskmates)) {
    rmSync(join(cwd, "agent", "subagents", id), { recursive: true, force: true });
  }

  // Remove stale generated subagent dirs for deskmates no longer in the config, then
  // (re)write the whole tree.
  for (const del of plan.deletes) rmSync(del, { recursive: true, force: true });
  for (const { path, contents } of plan.writes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  console.log(
    `✓ deskmate sync: wrote ${plan.writes.length} file(s), removed ${plan.deletes.length} stale subagent dir(s).`,
  );
  for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
}
