import { describe, it, expect } from "vitest";
import { renderMcpConnection, renderConnectConnection } from "../src/lib/mcp-template.js";

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

describe("renderConnectConnection", () => {
  it("renders an app-scoped Vercel Connect connection", () => {
    const out = renderConnectConnection({
      name: "vercel",
      connector: "vercel/deskmate",
      url: "https://mcp.vercel.com",
      description: "Vercel projects, deployments, and logs (read-only).",
      tools: ["list_deployments", "get_deployment"],
    });
    expect(out).toContain('import { connect } from "@vercel/connect/eve";');
    expect(out).toContain('import { defineMcpClientConnection } from "eve/connections";');
    expect(out).toContain('url: "https://mcp.vercel.com"');
    expect(out).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
    expect(out).toContain('tools: { allow: ["list_deployments", "get_deployment"] }');
    expect(out).not.toContain("process.env");
    expect(out).not.toContain("getToken");
  });

  it("renders an empty allow-list when no tools are given", () => {
    const out = renderConnectConnection({
      name: "x", connector: "x/deskmate", url: "https://mcp.x.com", description: "d", tools: [],
    });
    expect(out).toContain("tools: { allow: [] }");
  });
});
