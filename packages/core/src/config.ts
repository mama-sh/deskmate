import { z } from "zod";

const ConnectionConfig = z.object({
  kind: z.literal("mcp"),
  env: z.string().optional(),      // env prefix → <ENV>_MCP_URL/_TOKEN
});

const MemorySetting = z.object({
  maxItems: z.number().int().positive().default(200),
  coreLimit: z.number().int().positive().default(25),
});

const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
  voice: z.string().optional(), // one line of persona/register, injected under the shared house style
  // Opt-in cross-thread memory. `true` normalizes to the MemorySetting defaults;
  // `false`/omitted stay off (undefined). An object opts in with overrides, and its
  // branch parses through MemorySetting so inner defaults (e.g. coreLimit) still apply.
  memory: z.union([z.boolean(), MemorySetting]).optional().transform((m) => {
    if (m === undefined || m === false) return undefined;
    return m === true ? MemorySetting.parse({}) : m;
  }),
});

const ChannelWatch = z.object({
  react: z.boolean().default(true),
  reply: z.boolean().default(true),
  post: z.boolean().default(false),
  approvePosts: z.boolean().default(false),
  picker: z.enum(["routed", "frontdesk"]).default("routed"),
  reactionPalette: z.array(z.string()).nonempty().optional(),
  digest: z.boolean().optional(),
});

// `watch` is `.optional()` (NOT `.default({})`): an omitted `watch` means "not
// watched" and stays undefined, while a present `watch` (even `{}`) is re-parsed so
// the inner `.default()`s fill in. zod v4's `.default({})` would return the literal
// `{}` without re-parsing, skipping those inner defaults: the same gotcha the
// `frontDesk` field above documents with `.prefault({})`.
const ChannelRoute = z.object({
  deskmate: z.string(),
  lock: z.boolean().optional(),
  watch: ChannelWatch.optional(),
});

const TeamConfig = z.object({
  model: z.string().default("anthropic/claude-sonnet-5"),
  // .prefault({}) (not .default({})) so the inner maxTurns default is applied when
  // frontDesk is omitted: zod v4's .default() returns the fallback value as-is
  // without re-parsing it, whereas .prefault() runs it through the schema.
  frontDesk: z.object({ maxTurns: z.number().int().positive().default(6) }).prefault({}),
  sweep: z.object({ cron: z.string() }).optional(),
  // Team-level memory knob (accepted but unwired until a later task adds reflection).
  memory: z.object({ reflect: z.object({ cron: z.string() }).optional() }).optional(),
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
    // `role` is used as a filesystem path segment by `deskmate sync` (roles/<role>/…
    // and the generated re-export specifiers), so guard it with the same identifier
    // rule as ids/connection names — otherwise a value like "../.." could traverse
    // outside roles/.
    if (!IDENTIFIER_RE.test(d.role)) {
      throw new Error(
        `deskmate "${id}" has role "${d.role}" which must be snake_case (a lowercase letter, then ` +
          `letters/digits/underscores) — it becomes a directory path segment (roles/<role>/…).`,
      );
    }
    for (const r of d.reads) {
      if (!team.connections[r]) throw new Error(`deskmate "${id}" reads unknown connection "${r}"`);
    }
  }
  for (const [ch, route] of Object.entries(team.channels)) {
    if (!team.deskmates[route.deskmate]) throw new Error(`channel "${ch}" routes to unknown deskmate "${route.deskmate}"`);
  }
  return team;
}
