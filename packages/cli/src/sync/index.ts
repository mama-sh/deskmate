import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTeam, type TeamConfig } from "@deskmate/core";
import { planSync } from "./plan.js";

export const CONFIG_FILE = "deskmate.config.ts";

let importSeq = 0;

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
export async function syncCommand(
  cwd: string = process.cwd(),
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILE} found in ${cwd}. Run \`deskmate add <id>\` first.`);
  }

  let mod: { default?: unknown };
  try {
    // `deskmate dev` re-syncs in one long-lived process; ESM caches modules by URL,
    // so re-importing the same config path returns the stale original. A unique query
    // string forces re-evaluation so config edits live-reload. (Registry grows by one
    // module per re-sync — negligible for a dev session.)
    mod = (await import(pathToFileURL(configPath).href + `?reload=${++importSeq}`)) as {
      default?: unknown;
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not load ${CONFIG_FILE} (${reason}). Loading a .ts config needs Node ≥23.6 ` +
        `(native type-stripping) or \`node --experimental-strip-types\`.`,
    );
  }
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(
      `${CONFIG_FILE} must \`export default\` a team config object (optionally wrapped in \`defineTeam({ … })\`).`,
    );
  }

  // Validate + normalize through defineTeam whether or not the consumer already
  // wrapped their config with it (re-parsing is idempotent): this applies schema
  // defaults (e.g. frontDesk.maxTurns) and runs the cross-reference checks, so an
  // invalid config fails here with a clear reason instead of generating a broken tree.
  let team: TeamConfig;
  try {
    team = defineTeam(mod.default);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid ${CONFIG_FILE}: ${reason}`);
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

  // Watch-mode re-syncs pass `{ quiet: true }`: they run under an interactive TUI,
  // so any stray stdout here would corrupt the display. Default path is unchanged.
  if (!opts.quiet) {
    console.log(
      `✓ deskmate sync: wrote ${plan.writes.length} file(s), removed ${plan.deletes.length} stale subagent dir(s).`,
    );
    for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
  }
}
