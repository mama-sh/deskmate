import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TeamConfig } from "@deskmate/core";
import {
  renderAvatarsChannel,
  renderDeskmateSaysTool,
  renderEnvExample,
  renderEveChannel,
  renderFrontDeskInstructions,
  renderReexport,
  renderRootAgent,
  renderRosterRegistry,
  renderSlackAmbientChannel,
  renderSlackChannel,
  renderStubConnection,
  renderSubagentAgent,
} from "./render.js";

export type FileWrite = { path: string; contents: string };
export type SyncPlan = {
  writes: FileWrite[];
  deletes: string[];
  /** Human-readable notes (stubbed connections, missing instructions) for the CLI to surface. */
  warnings: string[];
};

// Placeholder written when a deskmate has no authored roles/<id>/instructions.md.
// `deskmate add` always copies one, so this only fires for a hand-added deskmate.
function missingInstructions(id: string): string {
  return `# ${id}\n\n<!-- TODO: no authored roles/${id}/instructions.md found. Add one, then re-run \`deskmate sync\`. -->\n`;
}

/** Directory entries that are themselves directories, sorted for deterministic output. */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** `*.ts` files in a dir (non-recursive), sorted for deterministic output. */
function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

/**
 * Every file under `root`, recursively, as POSIX-style paths relative to `root`
 * (including dotfiles/dirs like `templates/.github/…`). Entries are sorted at each
 * directory level, so the flattened list is deterministic → idempotent writes.
 */
function walkFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Compute the full set of file writes + directory deletes that rebuild `agent/**`
 * from the consumer's `deskmate.config.ts` (passed in as a parsed `team` object)
 * and their authored `roles/<id>/` + shared `connections/` files under `cwd`.
 *
 * Pure w.r.t. its inputs (team + the filesystem under cwd): it performs no writes.
 * Deterministic — directory listings are sorted — so re-running with the same
 * inputs yields byte-identical `writes` (see the idempotency test). All returned
 * paths are absolute (joined to `cwd`).
 */
export function planSync(team: TeamConfig, cwd: string): SyncPlan {
  const writes: FileWrite[] = [];
  const warnings: string[] = [];
  const out = (rel: string, contents: string) => writes.push({ path: join(cwd, rel), contents });

  // ── Root files ────────────────────────────────────────────────────────────
  out("agent/agent.ts", renderRootAgent(team));
  out("agent/instructions.md", renderFrontDeskInstructions());
  out("agent/lib/deskmates.ts", renderRosterRegistry(team));
  out("agent/tools/deskmate_says.ts", renderDeskmateSaysTool());
  out("agent/channels/slack.ts", renderSlackChannel());
  out("agent/channels/slack-ambient.ts", renderSlackAmbientChannel());
  out("agent/channels/eve.ts", renderEveChannel());
  out("agent/channels/deskmate-avatars.ts", renderAvatarsChannel());
  out(".env.example", renderEnvExample(team));

  // ── Per-deskmate subagent tree ──────────────────────────────────────────────
  for (const [id, d] of Object.entries(team.deskmates)) {
    out(`agent/subagents/${id}/agent.ts`, renderSubagentAgent(id));

    // instructions.md — authored file copied VERBATIM (byte-for-byte, no banner).
    const instrPath = join(cwd, "roles", id, "instructions.md");
    if (existsSync(instrPath)) {
      out(`agent/subagents/${id}/instructions.md`, readFileSync(instrPath, "utf8"));
    } else {
      out(`agent/subagents/${id}/instructions.md`, missingInstructions(id));
      warnings.push(`deskmate "${id}": no authored roles/${id}/instructions.md — wrote a TODO placeholder.`);
    }

    // tools/<tool>.ts — one re-export shim per authored roles/<id>/tools/*.ts.
    for (const tool of tsFiles(join(cwd, "roles", id, "tools"))) {
      out(
        `agent/subagents/${id}/tools/${tool}`,
        renderReexport(`../../../../roles/${id}/tools/${tool.replace(/\.ts$/, ".js")}`, { star: true }),
      );
    }

    // connections/<name>.ts — one shim per `reads` name. Resolution order:
    //   1. deskmate-local  roles/<id>/connections/<name>.ts
    //   2. shared          connections/<name>.ts   (repo root)
    //   3. TODO stub       (neither exists — don't crash)
    for (const name of d.reads) {
      const local = join(cwd, "roles", id, "connections", `${name}.ts`);
      const shared = join(cwd, "connections", `${name}.ts`);
      let contents: string;
      if (existsSync(local)) {
        contents = renderReexport(`../../../../roles/${id}/connections/${name}.js`, { star: true });
      } else if (existsSync(shared)) {
        contents = renderReexport(`../../../../connections/${name}.js`, { star: true });
      } else {
        contents = renderStubConnection(name, team.connections[name]?.env);
        warnings.push(
          `deskmate "${id}": connection "${name}" has no authored file (roles/${id}/connections/${name}.ts ` +
            `or connections/${name}.ts) — wrote a TODO stub.`,
        );
      }
      out(`agent/subagents/${id}/connections/${name}.ts`, contents);
    }

    // skills/** — the deskmate's authored skill playbooks (SKILL.md + rules/
    // references/templates), copied VERBATIM with their nested structure. These
    // are markdown/asset files Eve discovers under agent/subagents/<id>/skills/;
    // they are copied like instructions.md (no shim, no banner). The `skill`
    // field in the config stays metadata — sync just copies the tree.
    const skillsRoot = join(cwd, "roles", id, "skills");
    for (const rel of walkFiles(skillsRoot)) {
      out(`agent/subagents/${id}/skills/${rel}`, readFileSync(join(skillsRoot, rel), "utf8"));
    }
  }

  // ── Deletes: generated subagent dirs for deskmates no longer in the config ──
  const deletes: string[] = [];
  for (const existing of subdirs(join(cwd, "agent", "subagents"))) {
    if (!team.deskmates[existing]) deletes.push(join(cwd, "agent", "subagents", existing));
  }

  return { writes, deletes, warnings };
}
