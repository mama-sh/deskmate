import { defineMcpClientConnection } from "eve/connections";

// Catalog entry: an external error/observability MCP server (Sentry).
// Single-deployment auth model: the token comes from env. Set SENTRY_MCP_URL +
// SENTRY_MCP_TOKEN to run against a real org. Read-only by construction.
export default defineMcpClientConnection({
  url: process.env.SENTRY_MCP_URL ?? "https://example.invalid/mcp",
  description:
    "Read-only error monitoring (Sentry): search issues, fetch issue/event details, list " +
    "recent releases. Use to ground incident answers in real error data.",
  auth: { getToken: async () => ({ token: process.env.SENTRY_MCP_TOKEN ?? "" }) },
  // Read-only surface. Replace these with your MCP server's actual read tools.
  tools: { allow: ["list_issues", "get_issue", "list_events", "get_event"] },
});
