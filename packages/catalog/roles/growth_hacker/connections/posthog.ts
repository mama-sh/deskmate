import { defineMcpClientConnection } from "eve/connections";

// Catalog entry: an external product/growth-analytics MCP server (PostHog).
// Single-deployment auth model: token from env. Set POSTHOG_MCP_URL +
// POSTHOG_MCP_TOKEN to run against a real project. Read-only by construction.
export default defineMcpClientConnection({
  url: process.env.POSTHOG_MCP_URL || "https://example.invalid/mcp",
  description:
    "Read-only growth analytics (PostHog): run queries, fetch insights and funnels, list " +
    "dashboards. Use to ground funnel and conversion answers in real data.",
  auth: { getToken: async () => ({ token: process.env.POSTHOG_MCP_TOKEN || "" }) },
  // Read-only surface. Replace these with your MCP server's actual read tools.
  tools: { allow: ["run_query", "get_insight", "list_insights", "get_funnel"] },
});
