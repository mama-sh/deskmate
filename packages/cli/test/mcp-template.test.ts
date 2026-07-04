import { describe, it, expect } from "vitest";
import { renderMcpConnection } from "../src/lib/mcp-template.js";

describe("renderMcpConnection", () => {
  it("renders a read-only, env-token connection from options", () => {
    const out = renderMcpConnection({
      name: "datadog",
      urlEnv: "DATADOG_MCP_URL",
      tokenEnv: "DATADOG_MCP_TOKEN",
      description: "Read-only Datadog: search logs and monitors.",
      tools: ["search_logs", "get_monitor"],
    });
    expect(out).toContain('import { defineMcpClientConnection } from "eve/connections";');
    expect(out).toContain("process.env[\"DATADOG_MCP_URL\"] ?? \"https://example.invalid/mcp\"");
    expect(out).toContain("process.env[\"DATADOG_MCP_TOKEN\"] ?? \"\"");
    expect(out).toContain('tools: { allow: ["search_logs", "get_monitor"] }');
    expect(out).toContain("Read-only Datadog: search logs and monitors.");
  });

  it("renders an empty allow-list when no tools are given", () => {
    const out = renderMcpConnection({
      name: "x", urlEnv: "X_MCP_URL", tokenEnv: "X_MCP_TOKEN", description: "d", tools: [],
    });
    expect(out).toContain("tools: { allow: [] }");
  });
});
