import { z } from "zod";

const ConnectionConfig = z.object({
  kind: z.enum(["mcp", "tool"]),
  env: z.string().optional(),      // env prefix → <ENV>_MCP_URL/_TOKEN for kind:"mcp"
  repo: z.string().optional(),
  from: z.string().optional(),     // module path for kind:"tool"
  apps: z.array(z.string()).optional(),
}).passthrough();

const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
  instructions: z.string().optional(), // path override; defaults to roles/<id>/instructions.md
  tools: z.array(z.string()).optional(),
});

const ChannelRoute = z.object({ deskmate: z.string(), lock: z.boolean().optional() });

const TeamConfig = z.object({
  model: z.string().default("anthropic/claude-sonnet-4.6"),
  // .prefault({}) (not .default({})) so the inner maxTurns default is applied when
  // frontDesk is omitted: zod v4's .default() returns the fallback value as-is
  // without re-parsing it, whereas .prefault() runs it through the schema.
  frontDesk: z.object({ maxTurns: z.number().int().positive().default(6) }).prefault({}),
  connections: z.record(z.string(), ConnectionConfig).default({}),
  deskmates: z.record(z.string(), DeskmateConfig).default({}),
  channels: z.record(z.string(), ChannelRoute).default({}),
});

export type TeamConfig = z.infer<typeof TeamConfig>;
export type DeskmateConfig = z.infer<typeof DeskmateConfig>;
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

export function defineTeam(input: unknown): TeamConfig {
  const team = TeamConfig.parse(input);
  for (const [id, d] of Object.entries(team.deskmates)) {
    for (const r of d.reads) {
      if (!team.connections[r]) throw new Error(`deskmate "${id}" reads unknown connection "${r}"`);
    }
  }
  for (const [ch, route] of Object.entries(team.channels)) {
    if (!team.deskmates[route.deskmate]) throw new Error(`channel "${ch}" routes to unknown deskmate "${route.deskmate}"`);
  }
  return team;
}
