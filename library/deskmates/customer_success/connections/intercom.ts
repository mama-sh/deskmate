import { defineMcpClientConnection } from "eve/connections";

// Catalog entry: an external support/CRM MCP server (Intercom).
// Single-deployment auth model: token from env. Set INTERCOM_MCP_URL +
// INTERCOM_MCP_TOKEN to run against a real workspace. Read-only by construction.
export default defineMcpClientConnection({
  url: process.env.INTERCOM_MCP_URL ?? "https://example.invalid/mcp",
  description:
    "Read-only customer support (Intercom): search contacts and conversations, fetch " +
    "conversation details, search help articles. Use to ground account-health answers.",
  auth: { getToken: async () => ({ token: process.env.INTERCOM_MCP_TOKEN ?? "" }) },
  // Read-only surface. Replace these with your MCP server's actual read tools.
  tools: { allow: ["search_contacts", "get_contact", "list_conversations", "get_conversation"] },
});
