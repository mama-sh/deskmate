import { describe, it, expect } from "vitest";
import { probeMcp } from "../src/lib/mcp-probe.js";

const resp = (body: unknown, init: { status?: number; sse?: boolean; sessionId?: string } = {}) => {
  const headers = new Headers();
  headers.set("content-type", init.sse ? "text/event-stream" : "application/json");
  if (init.sessionId) headers.set("mcp-session-id", init.sessionId);
  const text = init.sse ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body);
  return new Response(text, { status: init.status ?? 200, headers });
};

describe("probeMcp", () => {
  it("returns tool names from a JSON tools/list response", async () => {
    const fetchImpl = async (_url: string, opts: any) => {
      const method = JSON.parse(opts.body).method;
      if (method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, { sessionId: "abc" });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "tools/list") return resp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }, { name: "get" }] } });
      return resp({}, { status: 400 });
    };
    const r = await probeMcp("https://x/mcp", { Authorization: "Bearer t" }, fetchImpl as any);
    expect(r.reachable).toBe(true);
    expect(r.authOk).toBe(true);
    expect(r.tools).toEqual(["search", "get"]);
  });

  it("parses an SSE tools/list response", async () => {
    const fetchImpl = async (_url: string, opts: any) => {
      const method = JSON.parse(opts.body).method;
      if (method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} }, { sse: true });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      return resp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "only" }] } }, { sse: true });
    };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.tools).toEqual(["only"]);
  });

  it("reassembles a JSON-RPC message split across multiple SSE data: lines", async () => {
    const fetchImpl = async (_url: string, opts: any) => {
      const method = JSON.parse(opts.body).method;
      if (method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      // Pretty-printed JSON (real newlines) emitted one line per SSE `data:` field.
      const pretty = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "split" }] } }, null, 2);
      const body = "event: message\n" + pretty.split("\n").map((l) => `data: ${l}`).join("\n") + "\n\n";
      return new Response(body, { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) });
    };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.tools).toEqual(["split"]);
  });

  it("reports auth failure on a 401", async () => {
    const fetchImpl = async () => new Response("unauthorized", { status: 401 });
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.reachable).toBe(true);
    expect(r.authOk).toBe(false);
    expect(r.status).toBe(401);
  });

  it("reports unreachable on a transport error", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.reachable).toBe(false);
    expect(r.error).toContain("ECONNREFUSED");
  });

  it("times out (reachable:false) instead of hanging when the server never responds", async () => {
    // A fetch that hangs until its abort signal fires — models a stalled connection.
    const hangingFetch = (_url: string, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
      });
    const r = await probeMcp("https://x/mcp", {}, hangingFetch as any, 20);
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/abort|timeout/i);
  });

  it("walks tools/list pagination via nextCursor and accumulates every page", async () => {
    const fetchImpl = async (_url: string, opts: any) => {
      const req = JSON.parse(opts.body);
      if (req.method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} });
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      // tools/list: page 1 (no cursor) → nextCursor "p2"; page 2 (cursor "p2") → last page.
      if (req.params?.cursor === "p2") {
        return resp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "page2_tool" }] } });
      }
      return resp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "page1_tool" }], nextCursor: "p2" } });
    };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.tools).toEqual(["page1_tool", "page2_tool"]);
  });

  it("caps pagination at 20 pages and surfaces a truncation error when the cursor never clears", async () => {
    let pages = 0;
    const fetchImpl = async (_url: string, opts: any) => {
      const req = JSON.parse(opts.body);
      if (req.method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} });
      if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
      pages++;
      return resp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: `t${pages}` }], nextCursor: `c${pages}` } });
    };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(pages).toBe(20); // stopped at the cap, didn't loop forever
    expect(r.tools).toHaveLength(20);
    expect(r.error).toContain("20 pages");
    expect(r.authOk).toBe(true);
  });

  it("picks the JSON-RPC response frame from a multi-frame SSE body (notification first)", async () => {
    const fetchImpl = async (_url: string, opts: any) => {
      const method = JSON.parse(opts.body).method;
      if (method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} }, { sse: true });
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      // A notification frame (no result/error) precedes the actual tools/list response frame.
      const headers = new Headers({ "content-type": "text/event-stream" });
      const body =
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}\n\n` +
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "real" }] } })}\n\n`;
      return new Response(body, { status: 200, headers });
    };
    const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(r.tools).toEqual(["real"]);
  });

  it("sends the Mcp-Session-Id from initialize on the follow-up requests", async () => {
    const seen: Record<string, string | null> = {};
    const fetchImpl = async (_url: string, opts: any) => {
      const method = JSON.parse(opts.body).method;
      const h = new Headers(opts.headers);
      if (method === "initialize") return resp({ jsonrpc: "2.0", id: 1, result: {} }, { sessionId: "sess-42" });
      seen[method] = h.get("mcp-session-id");
      if (method === "tools/list") return resp({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
      return new Response(null, { status: 202 });
    };
    await probeMcp("https://x/mcp", {}, fetchImpl as any);
    expect(seen["tools/list"]).toBe("sess-42");
  });
});
