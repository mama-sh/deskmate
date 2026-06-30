import { defineMcpClientConnection } from "eve/connections";

// Catalog entry: an external product-analytics MCP server (Mixpanel).
// Single-deployment auth model: the token comes from env. To run for a real
// workspace, set MIXPANEL_MCP_URL + MIXPANEL_MCP_TOKEN. The model never sees
// the URL or token — it discovers tools via connection_search.
export default defineMcpClientConnection({
  url: process.env.MIXPANEL_MCP_URL ?? "https://example.invalid/mcp",
  description:
    "Read-only product analytics (Mixpanel): run saved reports, query events, fetch " +
    "metric values and dashboards. Use to ground product-metric answers in real data.",
  auth: { getToken: async () => ({ token: process.env.MIXPANEL_MCP_TOKEN ?? "" }) },
  // Read-only surface. Replace these with your MCP server's actual read tools.
  tools: { allow: ["run_query", "get_report", "get_metric", "list_dashboards"] },
});
