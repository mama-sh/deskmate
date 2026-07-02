import { defineAgent } from "eve";
import type { TeamConfig } from "./config.js";

/** Pure: derive the defineAgent config (description = routing hint) for a deskmate id. */
export function deskmateAgentConfig(team: TeamConfig, id: string): { description: string; model: string } {
  const d = team.deskmates[id];
  if (!d) throw new Error(`unknown deskmate "${id}"`);
  const description = `${d.emoji} ${d.displayName}. ${d.summary} Delegate here for ${d.role.replace(/_/g, " ")} questions.`;
  return { description, model: d.model ?? team.model };
}

/** Used inside a generated agent/subagents/<id>/agent.ts shim. */
export function defineDeskmate(team: TeamConfig, id: string) {
  return defineAgent(deskmateAgentConfig(team, id));
}
