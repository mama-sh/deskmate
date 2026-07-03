import { z } from "zod";

const ConnectionConfig = z.object({
  kind: z.literal("mcp"),
  env: z.string().optional(),      // env prefix → <ENV>_MCP_URL/_TOKEN
});

const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
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

// Deskmate ids and connection names become directory names AND import specifiers in
// the generated `agent/**` tree, so they must be safe snake_case identifiers (same
// guard as `deskmate mcp-add`). Channel keys are exempt — they are Slack channel ids.
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

export function defineTeam(input: unknown): TeamConfig {
  const team = TeamConfig.parse(input);
  for (const id of Object.keys(team.deskmates)) {
    if (!IDENTIFIER_RE.test(id)) {
      throw new Error(
        `deskmate id "${id}" must be snake_case (a lowercase letter, then letters/digits/underscores) — ` +
          `it becomes a directory name and import specifier.`,
      );
    }
  }
  for (const name of Object.keys(team.connections)) {
    if (!IDENTIFIER_RE.test(name)) {
      throw new Error(
        `connection name "${name}" must be snake_case (a lowercase letter, then letters/digits/underscores) — ` +
          `it becomes a directory name and import specifier.`,
      );
    }
  }
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
