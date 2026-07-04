import { defineTeam } from "@deskmate/core";

/**
 * The deskmate team for this app. `deskmate sync` reads this file and regenerates
 * the entire `agent/**` tree Eve discovers at build time — so this config (plus the
 * authored `roles/<id>/` files) is the single source of truth. Edit here, then run
 * `deskmate sync` (the `build` script does it for you).
 */
export default defineTeam({
  // Default model for the front desk and any deskmate that doesn't override it.
  // Models resolve through the Vercel AI Gateway.
  model: "anthropic/claude-sonnet-4.6",

  // External data each deskmate can read. `kind: "mcp"` connections map to an
  // <ENV>_MCP_URL / <ENV>_MCP_TOKEN pair (see the generated .env.example).
  connections: {
    mixpanel: { kind: "mcp", env: "MIXPANEL" },
    sentry: { kind: "mcp", env: "SENTRY" },
  },

  // The roster. Each entry's `role` names the authored `roles/<id>/` directory;
  // `reads` lists the connections that deskmate may query.
  deskmates: {
    product_analyst: {
      role: "product_analyst",
      emoji: ":bar_chart:",
      displayName: "Product Analyst",
      summary:
        "Turns product usage data into a short narrative: what changed, why, what to look at next.",
      skill: "ncklrs/startup-os-skills@product-analyst",
      voice: "Calm analyst. States what moved and the number behind it, then what to look at next. No hype.",
      reads: ["mixpanel"],
    },
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary:
        "Triages errors and incidents from logs/monitoring, explains likely causes, and proposes (never auto-applies) fixes.",
      skill: "erichowens/some_claude_skills@logging-observability",
      voice: "Terse SRE. Leads with the punchline, shows the query he ran, flags risk plainly. Dry, not chatty.",
      reads: ["sentry"],
    },
  },

  // No channel routing overrides by default.
  channels: {},
});
