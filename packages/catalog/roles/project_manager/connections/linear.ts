import { defineMcpClientConnection } from "eve/connections";

// Catalog entry: an external project-management MCP server (Linear).
// Single-deployment auth model: token from env. Set LINEAR_MCP_URL +
// LINEAR_MCP_TOKEN to run against a real workspace. Read-only by construction.
//
// Note: Linear also offers OAuth via Vercel Connect. To use it instead of an env
// token, swap `auth` for `connect("linear/deskmate")` from "@vercel/connect/eve"
// (see the connections guide). The single-deployment default keeps it env-only.
export default defineMcpClientConnection({
  url: process.env.LINEAR_MCP_URL || "https://example.invalid/mcp",
  description:
    "Read-only project tracking (Linear): list and search issues, fetch issue details, list " +
    "projects and cycles. Use to ground sprint-status answers in real issue data.",
  auth: { getToken: async () => ({ token: process.env.LINEAR_MCP_TOKEN || "" }) },
  // Read-only surface. Replace these with your MCP server's actual read tools.
  tools: { allow: ["list_issues", "get_issue", "search_issues", "list_projects"] },
});
