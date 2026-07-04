import { defineAgent } from "eve";
import { defineTeam, type TeamConfig } from "./config.js";

/**
 * Pure: derive the defineAgent config (description = routing hint) for a deskmate id.
 *
 * The incoming team is normalized through `defineTeam` first, so schema defaults —
 * especially `model` — are applied whether or not the consumer wrapped their config
 * in `defineTeam`. The generated subagent shim re-imports the RAW default export of
 * `deskmate.config`, so without this a consumer who omits `model` (relying on the
 * default) would otherwise get `model: undefined` here. `defineTeam` is idempotent,
 * so re-parsing an already-normalized team is a no-op.
 */
export function deskmateAgentConfig(teamInput: unknown, id: string): { description: string; model: string } {
  const team = defineTeam(teamInput);
  const d = team.deskmates[id];
  if (!d) throw new Error(`unknown deskmate "${id}"`);
  const description = `${d.emoji} ${d.displayName}. ${d.summary} Delegate here for ${d.role.replace(/_/g, " ")} questions.`;
  return { description, model: d.model ?? team.model };
}

/** Used inside a generated agent/subagents/<id>/agent.ts shim. */
export function defineDeskmate(team: TeamConfig | unknown, id: string) {
  return defineAgent(deskmateAgentConfig(team, id));
}
