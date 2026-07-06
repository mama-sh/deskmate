const PROTOCOL_VERSION = "2025-06-18";

export interface ProbeResult {
  reachable: boolean; // got any HTTP response, even 401/403
  authOk: boolean; // initialize returned a valid JSON-RPC result (no 401/403)
  tools?: string[]; // from tools/list, when authOk
  status?: number; // HTTP status of the initialize response
  error?: string; // transport/parse failure
}

type FetchLike = typeof fetch;

/** Extract the JSON-RPC message from a JSON or SSE (text/event-stream) body. */
async function readJsonRpc(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    // Parse SSE events (blank-line separated). Within one event, join its `data:` lines
    // with "\n" to reassemble the payload — the SSE spec allows a single message to span
    // multiple `data:` lines — then JSON-parse. Return the last event carrying a JSON-RPC
    // result/error (a server may interleave notification frames before the response).
    const msgs: any[] = [];
    for (const ev of text.split(/\r?\n\r?\n/)) {
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, "")) // strip one optional leading space per the spec
        .join("\n");
      if (!data) continue;
      try {
        msgs.push(JSON.parse(data));
      } catch {
        /* skip a non-JSON event */
      }
    }
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && (msgs[i].result !== undefined || msgs[i].error !== undefined)) return msgs[i];
    }
    return msgs.length ? msgs[msgs.length - 1] : {};
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Probe an MCP server over Streamable HTTP: initialize → notifications/initialized
 * → tools/list. Never throws — every failure maps to a {@link ProbeResult} field, so
 * `deskmate doctor` can report each connection without a try/catch per call. `fetchImpl`
 * is injected for tests. SSE-only servers that reject the initialize POST surface as
 * `reachable: false` with the server's message.
 */
export async function probeMcp(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike = fetch,
): Promise<ProbeResult> {
  const base = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  };
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetchImpl(url, { method: "POST", headers: { ...base, ...extra }, body: JSON.stringify(body) });

  let initRes: Response;
  try {
    initRes = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "deskmate-doctor", version: "0" } },
    });
  } catch (err) {
    return { reachable: false, authOk: false, error: err instanceof Error ? err.message : String(err) };
  }

  const status = initRes.status;
  if (status === 401 || status === 403) return { reachable: true, authOk: false, status };
  if (!initRes.ok) return { reachable: true, authOk: false, status, error: `initialize HTTP ${status}` };

  let initBody: any;
  try {
    initBody = await readJsonRpc(initRes);
  } catch (err) {
    return { reachable: true, authOk: false, status, error: `initialize parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (initBody?.error) return { reachable: true, authOk: false, status, error: initBody.error?.message ?? "initialize error" };

  const session = initRes.headers.get("mcp-session-id");
  const follow = { "mcp-protocol-version": PROTOCOL_VERSION, ...(session ? { "mcp-session-id": session } : {}) };

  // Best-effort readiness notification; ignore its outcome (some servers are stateless).
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, follow);
  } catch {
    /* ignore */
  }

  // tools/list is paginated (`result.nextCursor`). Walk every page — the doctor's
  // "does the allowed tool exist?" check would raise a false "missing" if a tool
  // lived past page 1. Bounded so a misbehaving server can't loop forever; partial
  // results (+ status) still flow back on a mid-walk failure.
  const tools: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    let listRes: Response;
    try {
      listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} }, follow);
    } catch (err) {
      return { reachable: true, authOk: true, tools, status, error: `tools/list: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (listRes.status === 401 || listRes.status === 403) return { reachable: true, authOk: false, status: listRes.status };
    if (!listRes.ok) return { reachable: true, authOk: true, tools, status, error: `tools/list HTTP ${listRes.status}` };

    let body: any;
    try {
      body = await readJsonRpc(listRes);
    } catch (err) {
      return { reachable: true, authOk: true, tools, status, error: `tools/list parse: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (Array.isArray(body?.result?.tools)) {
      for (const t of body.result.tools) if (typeof t?.name === "string") tools.push(t.name);
    }
    cursor = typeof body?.result?.nextCursor === "string" && body.result.nextCursor ? body.result.nextCursor : undefined;
    if (!cursor) break;
  }
  // Cap hit with a cursor still pending (huge tool set or a server that loops cursors):
  // the tool list is truncated. Surface it as an error so callers don't diff an
  // allow-list against a partial set and report a false "missing tool".
  if (cursor) {
    return { reachable: true, authOk: true, tools, status, error: "tools/list exceeded 20 pages (still paginating) — tool list truncated" };
  }
  return { reachable: true, authOk: true, tools, status };
}
