# Connection doctor + deploy/scaffolding hardening — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Close six deploy/connection-setup gaps a shakedown exposed: make `deskmate deploy` fail-fast on a bad env, stop an empty `_MCP_URL` from crashing `eve build`, add a `deskmate doctor` pre-deploy connection check, give `mcp-add` first-class non-Bearer auth schemes, and document the `vercel env add --value` trap.

**Architecture:** All changes live in `packages/cli` (plus one README edit). The centerpiece is a new `deskmate doctor` command that imports each authored connection file (the source of truth for `url`/`auth`/`headers`/`tools.allow`), resolves credentials from the local env exactly as the eve runtime would, and probes each MCP server over Streamable HTTP (`initialize → notifications/initialized → tools/list`) via a small, injected, unit-testable client. The auth-scheme change is deliberately confined to the connection *file* template so the config schema, `.env.example`, and stub renderer stay untouched.

**Tech Stack:** TypeScript (Node ≥23.6 native type-stripping, ESM), Vitest, `fetch` (global), the Vercel CLI (shelled out), eve `defineMcpClientConnection`.

> **Note on commits:** The repo owner prefers not to auto-commit. Each task ends with a commit *step*, but during execution pause and get a go-ahead before running the `git commit` (or batch commits at a checkpoint).

---

## Reference: current shapes (read before starting)

- `deploy()` — `packages/cli/src/deploy.ts`: `sync → vercel build --prod → patch → vercel deploy --prebuilt --prod`. Deps injected via `DeployDeps { sync, run, patch }`. Test: `packages/cli/test/deploy.test.ts` (uses a `makeDeps()` that records a `calls` array).
- `renderMcpConnection()` — `packages/cli/src/lib/mcp-template.ts`: pure string renderer for a token connection file. Test: `packages/cli/test/mcp-template.test.ts`.
- `renderStubConnection()` — `packages/cli/src/sync/render.ts:262`: the missing-file stub; line 292 has the duplicated `?? "https://example.invalid/mcp"`.
- `mcpAdd()` — `packages/cli/src/mcp-add.ts`: interactive; `withPrompts(ask)` helper; token path around lines 106-149. Test: `packages/cli/test/mcp-add.test.ts`.
- `loadTeam(cwd)` — `packages/cli/src/lib/load-config.ts`: dynamic-imports + validates `deskmate.config.ts`. Reuse its import idiom for connection files.
- Config: `connections.<name>` is `{ kind:"mcp", env }` (token) or `{ kind:"mcp", connect, service }` (oauth) — `packages/core/src/config.ts`.
- CLI dispatch: `packages/cli/src/cli.ts` (switch on `command`, `USAGE` array).

---

## Task 1: `deploy` pulls the target env first (fail-fast)

**Files:**
- Modify: `packages/cli/src/deploy.ts` (the `deploy()` body + doc comment)
- Test: `packages/cli/test/deploy.test.ts`

**Step 1: Write the failing tests**

Add to the `describe("deploy", …)` block in `deploy.test.ts` (adjust the existing two tests' expected `calls` arrays to include the new first entry):

```ts
it("pulls the production env before anything else, then sync → build → patch → deploy", async () => {
  const { deps, calls } = makeDeps([0, 0, 0]); // pull, build, deploy
  const code = await deploy(["--yes"], "/proj", deps);
  expect(code).toBe(0);
  expect(calls).toEqual([
    "run:vercel pull --yes --environment=production --yes",
    "sync",
    "run:vercel build --prod --yes [xfw]",
    "patch",
    "run:vercel deploy --prebuilt --prod --yes",
  ]);
});

it("short-circuits (no sync/build/patch/deploy) when the env pull fails", async () => {
  const { deps, calls } = makeDeps([3]); // pull exits non-zero
  const code = await deploy([], "/proj", deps);
  expect(code).toBe(3);
  expect(calls).toEqual(["run:vercel pull --environment=production [xfw?]".replace(" [xfw?]", "")]);
  expect(deps.sync).not.toHaveBeenCalled();
  expect(deps.patch).not.toHaveBeenCalled();
});
```

Also update the two EXISTING tests to prepend `"run:vercel pull --yes --environment=production"` (no passthrough for the second) to their `calls` arrays, and pass an extra leading `0` to `makeDeps([...])` so the pull succeeds. Note: `makeDeps`'s `run` mock appends `[xfw]` only when `env.VERCEL_USE_EXPERIMENTAL_FRAMEWORKS` is set — the pull call passes the same `xfw` env (harmless; keep it) OR no env. Decide in Step 3 and make the expected strings match. Simplest: give `pull` the SAME xfw env as build so the mock formatting is uniform, and expect `... --environment=production --yes [xfw]`. Rewrite the Step-1 expectations to match whatever Step 3 does — the point is: pull is first, and a non-zero pull returns its code and runs nothing else.

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @deskmate/cli test deploy`
Expected: FAIL (pull step not yet emitted; calls arrays mismatch).

**Step 3: Implement**

In `deploy.ts`, insert before `await deps.sync(cwd);`:

```ts
// Step 0: pull the production env so `vercel build` validates connections against
// the REAL deploy env, not a stale `.vercel/.env.production.local`. Fail-fast — a
// misconfigured connection URL/token surfaces here, locally, instead of shipping a
// bot that 500s on first use. Passthrough auth/scope args (e.g. --token, --scope)
// reach the pull too, since it needs the same credentials in CI.
const pullCode = await deps.run(
  "vercel",
  ["pull", "--yes", "--environment=production", ...args],
  cwd,
  { VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1" },
);
if (pullCode !== 0) return pullCode;
```

Update the function doc comment's recipe line to: `pull → sync → vercel build (…) → patch eve trace → vercel deploy --prebuilt`.

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @deskmate/cli test deploy`
Expected: PASS. Also run `pnpm --filter @deskmate/cli typecheck`.

**Step 5: Commit**

```bash
git add packages/cli/src/deploy.ts packages/cli/test/deploy.test.ts
git commit -m "fix(cli): deskmate deploy pulls prod env first (fail-fast)"
```

---

## Task 2: `??` → `||` on URL fallbacks (empty env no longer crashes build)

**Files:**
- Modify: `packages/cli/src/lib/mcp-template.ts:17,19`
- Modify: `packages/cli/src/sync/render.ts:292,294`
- Test: `packages/cli/test/mcp-template.test.ts`, `packages/cli/test/render.test.ts` (if present)

**Step 1: Write the failing test**

Add to `mcp-template.test.ts`:

```ts
it("uses || (not ??) for the URL fallback so an empty-string env still falls back", () => {
  const src = renderMcpConnection({
    name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN",
    description: "Acme.", tools: ["search"],
  });
  expect(src).toContain('process.env["ACME_MCP_URL"] || "https://example.invalid/mcp"');
  expect(src).not.toContain("?? \"https://example.invalid/mcp\"");
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @deskmate/cli test mcp-template`
Expected: FAIL (still emits `??`).

**Step 3: Implement**

In `mcp-template.ts`, change line 17 `?? "https://example.invalid/mcp"` → `|| "https://example.invalid/mcp"`, and line 19 `?? ""` → `|| ""` (consistency; no behavior change). Make the identical change in `sync/render.ts` at line 292 (URL) and 294 (token) inside `renderStubConnection`.

**Step 4: Run to verify it passes**

Run: `pnpm --filter @deskmate/cli test` (run the whole CLI suite — render/stub tests may assert on the string too; update any that expect `??`).
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/cli/src/lib/mcp-template.ts packages/cli/src/sync/render.ts packages/cli/test/
git commit -m "fix(cli): fall back on empty _MCP_URL with || not ?? (avoids invalid url: \"\")"
```

---

## Task 3: `renderMcpConnection` gains a `scheme` param (bearer/basic/custom-header)

**Files:**
- Modify: `packages/cli/src/lib/mcp-template.ts` (`McpTemplateOptions` + `renderMcpConnection`)
- Test: `packages/cli/test/mcp-template.test.ts`

**Step 1: Write the failing tests**

```ts
it("bearer scheme (default) emits auth.getToken with a Bearer token", () => {
  const src = renderMcpConnection({
    name: "acme", urlEnv: "ACME_MCP_URL", tokenEnv: "ACME_MCP_TOKEN",
    description: "Acme.", tools: ["search"],
  });
  expect(src).toContain("auth: { getToken: async () => ({ token: process.env[\"ACME_MCP_TOKEN\"] || \"\" }) }");
  expect(src).not.toContain("headers:");
});

it("basic scheme base64-encodes the token env (plaintext pk:sk) into an Authorization: Basic header", () => {
  const src = renderMcpConnection({
    name: "lf", urlEnv: "LF_MCP_URL", tokenEnv: "LF_MCP_TOKEN",
    description: "Langfuse.", tools: ["traces"], scheme: "basic",
  });
  expect(src).toContain('Basic ${Buffer.from(process.env["LF_MCP_TOKEN"] || "").toString("base64")}');
  expect(src).toContain("headers: {");
  expect(src).not.toContain("auth:");
});

it("custom-header scheme sends the token under the named header", () => {
  const src = renderMcpConnection({
    name: "docs", urlEnv: "DOCS_MCP_URL", tokenEnv: "DOCS_MCP_TOKEN",
    description: "Docs.", tools: ["search"], scheme: "custom-header", headerName: "X-Api-Key",
  });
  expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
  expect(src).toContain("headers: {");
});
```

**Step 2: Run to verify they fail**

Run: `pnpm --filter @deskmate/cli test mcp-template`
Expected: FAIL (`scheme`/`headerName` not on the type; branches absent).

**Step 3: Implement**

Extend the type and renderer in `mcp-template.ts`:

```ts
export type McpAuthScheme = "bearer" | "basic" | "custom-header";

export type McpTemplateOptions = {
  name: string;
  urlEnv: string;
  tokenEnv: string;
  description: string;
  tools: string[];
  scheme?: McpAuthScheme;     // default "bearer"
  headerName?: string;        // required when scheme === "custom-header"
};

/** Pure: render the TypeScript source for a read-only, env-token MCP connection. */
export function renderMcpConnection(opts: McpTemplateOptions): string {
  const allow = opts.tools.map((t) => JSON.stringify(t)).join(", ");
  const url = `process.env[${JSON.stringify(opts.urlEnv)}] || "https://example.invalid/mcp"`;
  const tokenExpr = `process.env[${JSON.stringify(opts.tokenEnv)}] || ""`;
  const scheme = opts.scheme ?? "bearer";

  // Each scheme reuses the same <PREFIX>_MCP_URL + <PREFIX>_MCP_TOKEN pair; only the
  // way the token becomes a header differs, so the config entry, .env.example, and
  // stub renderer stay identical across schemes.
  let credLine: string;
  let hint: string;
  if (scheme === "basic") {
    // Token env holds plaintext "publicKey:secretKey"; base64-encode it at runtime.
    credLine = `  headers: { Authorization: \`Basic \${Buffer.from(${tokenExpr}).toString("base64")}\` },`;
    hint = `// Set ${opts.tokenEnv} to plaintext "publicKey:secretKey" (this file base64-encodes it).`;
  } else if (scheme === "custom-header") {
    const header = opts.headerName ?? "X-Api-Key";
    credLine = `  headers: { ${JSON.stringify(header)}: ${tokenExpr} },`;
    hint = `// Set ${opts.tokenEnv} to the ${header} value.`;
  } else {
    credLine = `  auth: { getToken: async () => ({ token: ${tokenExpr} }) },`;
    hint = `// Set ${opts.urlEnv} + ${opts.tokenEnv} to run against a real server, then redeploy.`;
  }

  return `import { defineMcpClientConnection } from "eve/connections";

// Generated by \`deskmate mcp-add\`. Read-only, env-token (single-deployment).
${hint}
export default defineMcpClientConnection({
  url: ${url},
  description: ${JSON.stringify(opts.description)},
${credLine}
  tools: { allow: [${allow}] },
});
`;
}
```

Note this folds in Task 2's `||` change for the token connection (keep both consistent). Keep the existing bearer test (from Task 2) green — the exact `auth:` string must match.

**Step 4: Run to verify they pass**

Run: `pnpm --filter @deskmate/cli test mcp-template && pnpm --filter @deskmate/cli typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/cli/src/lib/mcp-template.ts packages/cli/test/mcp-template.test.ts
git commit -m "feat(cli): mcp-add template supports bearer/basic/custom-header schemes"
```

---

## Task 4: `mcp-add` prompts for the token scheme

**Files:**
- Modify: `packages/cli/src/mcp-add.ts` (the token path, ~lines 106-123)
- Test: `packages/cli/test/mcp-add.test.ts`

**Step 1: Read the existing test to match its harness**

`mcp-add.test.ts` drives `mcpAdd` by feeding stdin lines. Study how it fakes prompts (piped lines consumed by `withPrompts`) and asserts on the written file. Mirror that.

**Step 2: Write the failing tests**

Add cases that feed the new `Token scheme` answer (and the header-name follow-up for `custom-header`) and assert the generated `connections/<name>.ts` contains the right credential line:

```ts
it("basic scheme writes an Authorization: Basic header connection file", async () => {
  // feed: mode=token, urlEnv default, tokenEnv default, description, tools, scheme=basic
  // (match the exact prompt ORDER in mcp-add.ts)
  // …drive mcpAdd in a temp cwd…
  const src = readFileSync(join(cwd, "connections", "lf.ts"), "utf8");
  expect(src).toContain('Basic ${Buffer.from(process.env["LF_MCP_TOKEN"] || "").toString("base64")}');
});

it("custom-header scheme asks a header name and uses it", async () => {
  // feed: …, scheme=custom-header, headerName=X-Api-Key
  const src = readFileSync(join(cwd, "connections", "docs.ts"), "utf8");
  expect(src).toContain('"X-Api-Key": process.env["DOCS_MCP_TOKEN"] || ""');
});
```

**Step 3: Run to verify they fail**

Run: `pnpm --filter @deskmate/cli test mcp-add`
Expected: FAIL.

**Step 4: Implement**

In `mcp-add.ts`, in the token path after the `description`/`tools` prompts and before writing the file, add:

```ts
const scheme = (await ask("Token scheme [bearer/basic/custom-header]", "bearer")).toLowerCase() as
  "bearer" | "basic" | "custom-header";
const headerName = scheme === "custom-header"
  ? await ask("Header name", "X-Api-Key")
  : undefined;
if (scheme === "basic") {
  console.log(`  basic auth: set ${tokenEnv} to plaintext "publicKey:secretKey" (it gets base64-encoded).`);
}
```

Pass `scheme, headerName` into `renderMcpConnection({ name, urlEnv, tokenEnv, description, tools, scheme, headerName })`. Leave the config entry (`{ kind:"mcp", env: urlPrefix }`) and the `.env.example` guidance UNCHANGED — the scheme is a file-only concern.

**Step 5: Run to verify they pass**

Run: `pnpm --filter @deskmate/cli test mcp-add && pnpm --filter @deskmate/cli typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/cli/src/mcp-add.ts packages/cli/test/mcp-add.test.ts
git commit -m "feat(cli): mcp-add prompts for token auth scheme (bearer/basic/custom-header)"
```

---

## Task 5: `lib/mcp-probe.ts` — minimal Streamable HTTP MCP client

**Files:**
- Create: `packages/cli/src/lib/mcp-probe.ts`
- Test: `packages/cli/test/mcp-probe.test.ts`

**Design:** POST JSON-RPC to the connection `url` with `Accept: application/json, text/event-stream`. `initialize` → capture any `Mcp-Session-Id` → POST `notifications/initialized` → POST `tools/list`. Responses may be JSON or SSE; parse both. `fetch` is injected so tests never hit the network.

**Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { probeMcp } from "../src/lib/mcp-probe.js";

const jsonResp = (body: unknown, init: Partial<{ status: number; sse: boolean; sessionId: string }> = {}) => {
  const status = init.status ?? 200;
  const headers = new Headers();
  const text = init.sse
    ? `event: message\ndata: ${JSON.stringify(body)}\n\n`
    : JSON.stringify(body);
  headers.set("content-type", init.sse ? "text/event-stream" : "application/json");
  if (init.sessionId) headers.set("mcp-session-id", init.sessionId);
  return new Response(text, { status, headers });
};

it("returns tool names from a JSON tools/list response", async () => {
  const calls: any[] = [];
  const fetchImpl = async (_url: string, opts: any) => {
    calls.push(JSON.parse(opts.body));
    const method = JSON.parse(opts.body).method;
    if (method === "initialize") return jsonResp({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "s" } } }, { sessionId: "abc" });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "tools/list") return jsonResp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search" }, { name: "get" }] } });
    return jsonResp({}, { status: 400 });
  };
  const r = await probeMcp("https://x/mcp", { Authorization: "Bearer t" }, fetchImpl as any);
  expect(r.reachable).toBe(true);
  expect(r.authOk).toBe(true);
  expect(r.tools).toEqual(["search", "get"]);
  // session id echoed on the follow-up calls' headers is verified via fetchImpl if desired
});

it("parses an SSE tools/list response", async () => {
  const fetchImpl = async (_url: string, opts: any) => {
    const method = JSON.parse(opts.body).method;
    if (method === "initialize") return jsonResp({ jsonrpc: "2.0", id: 1, result: {} }, { sse: true });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    return jsonResp({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "only" }] } }, { sse: true });
  };
  const r = await probeMcp("https://x/mcp", {}, fetchImpl as any);
  expect(r.tools).toEqual(["only"]);
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
```

**Step 2: Run to verify they fail**

Run: `pnpm --filter @deskmate/cli test mcp-probe`
Expected: FAIL (module missing).

**Step 3: Implement**

```ts
// packages/cli/src/lib/mcp-probe.ts
const PROTOCOL_VERSION = "2025-06-18";

export interface ProbeResult {
  reachable: boolean;   // got any HTTP response, even 401/403
  authOk: boolean;      // initialize returned a valid JSON-RPC result (no 401/403)
  tools?: string[];     // from tools/list, when authOk
  status?: number;      // HTTP status of the initialize response
  error?: string;       // transport/parse failure
}

type FetchLike = typeof fetch;

/** Extract the JSON-RPC message from a JSON or SSE (text/event-stream) body. */
async function readJsonRpc(res: Response): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    // Concatenate `data:` lines; take the last JSON object that has a result/error.
    const datas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(datas[i]!);
        if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj;
      } catch { /* keep scanning */ }
    }
    return datas.length ? JSON.parse(datas[datas.length - 1]!) : {};
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Probe an MCP server over Streamable HTTP: initialize → notifications/initialized
 * → tools/list. Never throws — every failure maps to a ProbeResult field. `fetchImpl`
 * is injected for tests. SSE-only (GET-stream) servers that reject the initialize
 * POST surface as `reachable: false` with the server's message.
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
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "deskmate-doctor", version: "0" } },
    });
  } catch (err) {
    return { reachable: false, authOk: false, error: err instanceof Error ? err.message : String(err) };
  }

  const status = initRes.status;
  if (status === 401 || status === 403) return { reachable: true, authOk: false, status };
  if (!initRes.ok) return { reachable: true, authOk: false, status, error: `initialize HTTP ${status}` };

  let initBody: any;
  try { initBody = await readJsonRpc(initRes); }
  catch (err) { return { reachable: true, authOk: false, status, error: `initialize parse: ${err instanceof Error ? err.message : String(err)}` }; }
  if (initBody?.error) return { reachable: true, authOk: false, status, error: initBody.error?.message ?? "initialize error" };

  const session = initRes.headers.get("mcp-session-id");
  const follow = { "mcp-protocol-version": PROTOCOL_VERSION, ...(session ? { "mcp-session-id": session } : {}) };

  // Best-effort readiness notification; ignore its outcome.
  try { await post({ jsonrpc: "2.0", method: "notifications/initialized" }, follow); } catch { /* ignore */ }

  let listRes: Response;
  try { listRes = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, follow); }
  catch (err) { return { reachable: true, authOk: true, error: `tools/list: ${err instanceof Error ? err.message : String(err)}` }; }
  if (listRes.status === 401 || listRes.status === 403) return { reachable: true, authOk: false, status: listRes.status };
  if (!listRes.ok) return { reachable: true, authOk: true, error: `tools/list HTTP ${listRes.status}` };

  try {
    const body = await readJsonRpc(listRes);
    const tools: string[] = Array.isArray(body?.result?.tools)
      ? body.result.tools.map((t: any) => t?.name).filter((n: unknown): n is string => typeof n === "string")
      : [];
    return { reachable: true, authOk: true, tools, status };
  } catch (err) {
    return { reachable: true, authOk: true, error: `tools/list parse: ${err instanceof Error ? err.message : String(err)}`, status };
  }
}
```

**Step 4: Run to verify they pass**

Run: `pnpm --filter @deskmate/cli test mcp-probe && pnpm --filter @deskmate/cli typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/cli/src/lib/mcp-probe.ts packages/cli/test/mcp-probe.test.ts
git commit -m "feat(cli): minimal Streamable HTTP MCP probe (initialize + tools/list)"
```

---

## Task 6: `doctor.ts` — resolve connections + report

**Files:**
- Create: `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Design:** `doctor()` takes injected deps (`loadTeam`, `resolveConnection`, `probe`) so the report/diff logic tests offline. Per connection: oauth (config `connect`) → warn-only "verified at runtime"; token (config `env`) → resolve the authored file → if unconfigured/not-found → warn; else probe → report reachable/authOk/tool-diff. Returns an exit code: `1` if any TOKEN connection is a hard failure (unreachable / auth-fail / an allowed tool missing on the server), else `0`. Warnings never fail the run.

**Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { doctor, type DoctorDeps } from "../src/doctor.js";

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadTeam: async () => ({
      connections: {
        good: { kind: "mcp", env: "GOOD" },
        wrongtool: { kind: "mcp", env: "WRONG" },
        oauthy: { kind: "mcp", connect: "svc/deskmate", service: "svc" },
        blank: { kind: "mcp", env: "BLANK" },
      },
      deskmates: {}, channels: {},
    }) as any,
    resolveConnection: async (name) => {
      if (name === "blank") return { kind: "unconfigured", url: "https://example.invalid/mcp" };
      if (name === "good") return { kind: "ready", url: "https://good/mcp", headers: { Authorization: "Bearer t" }, allow: ["search"] };
      if (name === "wrongtool") return { kind: "ready", url: "https://w/mcp", headers: {}, allow: ["does_not_exist"] };
      return { kind: "not-found" };
    },
    probe: async (url) => {
      if (url.includes("good")) return { reachable: true, authOk: true, tools: ["search", "extra"] };
      return { reachable: true, authOk: true, tools: ["real_tool"] };
    },
    ...over,
  };
}

it("passes (exit 0) when every token connection is reachable, authed, and allow-list matches", async () => {
  const d = deps({
    loadTeam: async () => ({ connections: { good: { kind: "mcp", env: "GOOD" } }, deskmates: {}, channels: {} }) as any,
  });
  expect(await doctor([], "/proj", d)).toBe(0);
});

it("fails (exit 1) when an allowed tool does not exist on the server", async () => {
  const d = deps({
    loadTeam: async () => ({ connections: { wrongtool: { kind: "mcp", env: "WRONG" } }, deskmates: {}, channels: {} }) as any,
  });
  expect(await doctor([], "/proj", d)).toBe(1);
});

it("fails (exit 1) on an auth failure", async () => {
  const d = deps({
    loadTeam: async () => ({ connections: { good: { kind: "mcp", env: "GOOD" } }, deskmates: {}, channels: {} }) as any,
    probe: async () => ({ reachable: true, authOk: false, status: 401 }),
  });
  expect(await doctor([], "/proj", d)).toBe(1);
});

it("treats unconfigured / not-found / oauth as warnings (exit 0)", async () => {
  const d = deps({
    loadTeam: async () => ({ connections: {
      blank: { kind: "mcp", env: "BLANK" },
      oauthy: { kind: "mcp", connect: "svc/deskmate" },
    }, deskmates: {}, channels: {} }) as any,
  });
  expect(await doctor([], "/proj", d)).toBe(0);
});
```

**Step 2: Run to verify they fail**

Run: `pnpm --filter @deskmate/cli test doctor`
Expected: FAIL (module missing).

**Step 3: Implement**

```ts
// packages/cli/src/doctor.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTeam as realLoadTeam } from "./lib/load-config.js";
import { probeMcp } from "./lib/mcp-probe.js";
import type { TeamConfig } from "@deskmate/core";
import type { ProbeResult } from "./lib/mcp-probe.js";

export type ResolvedConn =
  | { kind: "not-found" }
  | { kind: "unconfigured"; url: string }
  | { kind: "ready"; url: string; headers: Record<string, string>; allow: string[] };

export interface DoctorDeps {
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  resolveConnection: (name: string, cwd: string) => Promise<ResolvedConn>;
  probe: (url: string, headers: Record<string, string>) => Promise<ProbeResult>;
}

/** Locate the authored connection file: shared root, then any roles/<id>/connections/. */
function findConnectionFile(name: string, cwd: string): string | null {
  const shared = join(cwd, "connections", `${name}.ts`);
  if (existsSync(shared)) return shared;
  const rolesDir = join(cwd, "roles");
  if (existsSync(rolesDir)) {
    for (const id of readdirSync(rolesDir)) {
      const p = join(rolesDir, id, "connections", `${name}.ts`);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Import the authored file and resolve URL + outgoing headers as the runtime would. */
async function resolveConnectionReal(name: string, cwd: string): Promise<ResolvedConn> {
  const file = findConnectionFile(name, cwd);
  if (!file) return { kind: "not-found" };
  const mod = (await import(pathToFileURL(file).href)) as { default?: any };
  const def = mod.default ?? {};
  const url: string = typeof def.url === "string" ? def.url : "";
  const allow: string[] = Array.isArray(def.tools?.allow) ? def.tools.allow : [];

  const headers: Record<string, string> = {};
  if (def.headers && typeof def.headers === "object" && typeof def.headers !== "function") {
    for (const [k, v] of Object.entries(def.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (v && typeof (v as any).then === "function") headers[k] = String(await v);
      // function-valued headers need a session ctx — skip; probe reports the gap.
    }
  }
  if (def.auth && typeof def.auth.getToken === "function") {
    try {
      const { token } = await def.auth.getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } catch { /* getToken that needs a runtime ctx (e.g. connect) — leave unauthenticated */ }
  }

  if (!url || url.includes("example.invalid")) return { kind: "unconfigured", url: url || "(none)" };
  return { kind: "ready", url, headers, allow };
}

const defaultDeps: DoctorDeps = {
  loadTeam: realLoadTeam,
  resolveConnection: resolveConnectionReal,
  probe: (url, headers) => probeMcp(url, headers),
};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ⚠ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

/**
 * `deskmate doctor` (alias `check`): validate every configured MCP connection
 * against its real server before deploy. Run after `vercel env pull` so the local
 * env matches production. Exit 1 if any token connection is broken.
 */
export async function doctor(_args: string[] = [], cwd: string = process.cwd(), deps: DoctorDeps = defaultDeps): Promise<number> {
  const team = await deps.loadTeam(cwd);
  const names = Object.keys(team.connections);
  if (names.length === 0) { console.log("No connections configured."); return 0; }

  let failures = 0;
  for (const name of names) {
    const conn = team.connections[name]!;
    console.log(`\n${name}:`);

    if (conn.connect) {
      warn(`oauth (Vercel Connect: ${conn.connect}) — credential resolved at runtime; not checked here.`);
      continue;
    }

    const resolved = await deps.resolveConnection(name, cwd);
    if (resolved.kind === "not-found") { warn("no authored connection file — run `deskmate mcp-add " + name + "`."); continue; }
    if (resolved.kind === "unconfigured") { warn(`not configured (${resolved.url}) — set ${conn.env}_MCP_URL/_TOKEN.`); continue; }

    const r = await deps.probe(resolved.url, resolved.headers);
    if (!r.reachable) { bad(`unreachable: ${r.error ?? "no response"}`); failures++; continue; }
    if (!r.authOk) { bad(`auth failed${r.status ? ` (HTTP ${r.status})` : ""} — check ${conn.env}_MCP_TOKEN.`); failures++; continue; }
    ok(`reachable + authed (${r.tools?.length ?? 0} tools on server)`);

    const missing = resolved.allow.filter((t) => !(r.tools ?? []).includes(t));
    if (resolved.allow.length === 0) warn("no tools.allow set — the model sees every server tool.");
    else if (missing.length) { bad(`allow-list names tools the server does not expose: ${missing.join(", ")}`); failures++; }
    else ok(`all ${resolved.allow.length} allowed tool(s) exist on the server.`);
  }

  console.log(failures ? `\n✗ ${failures} connection(s) need attention.` : "\n✓ all connections healthy.");
  return failures ? 1 : 0;
}
```

**Step 4: Run to verify they pass**

Run: `pnpm --filter @deskmate/cli test doctor && pnpm --filter @deskmate/cli typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/cli/src/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): deskmate doctor — validate MCP connections before deploy"
```

---

## Task 7: Wire `doctor`/`check` into the CLI

**Files:**
- Modify: `packages/cli/src/cli.ts` (import, `USAGE`, switch)

**Step 1: Implement**

Add `import { doctor } from "./doctor.js";`. Add a `USAGE` line:
`"  deskmate doctor           check each MCP connection (reachable? authed? tools match?)",` (place it after the `deploy` line). Add cases:

```ts
case "doctor":
case "check":
  process.exitCode = await doctor(rest);
  break;
```

**Step 2: Verify**

Run: `pnpm --filter @deskmate/cli build` then `node packages/cli/bin/deskmate.mjs doctor` from a dir with no config → expect the friendly `no deskmate.config.ts found` error (exit 1), not a stack trace. From the repo `examples/starter` (if it has a config) → expect per-connection output. Also `pnpm --filter @deskmate/cli typecheck`.

**Step 3: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "feat(cli): wire up deskmate doctor / check"
```

---

## Task 8: Docs — `vercel env add --value` trap, doctor, basic pk:sk

**Files:**
- Modify: `README.md`

**Step 1: Implement**

1. Near the token-connection setup (around line 259-260, `deskmate mcp-add <name> → token, then set <PREFIX>_MCP_URL / <PREFIX>_MCP_TOKEN`), add:

   > **Setting env vars non-interactively:** `vercel env add <NAME> production` reads the value from **stdin only in an interactive TTY**. In agent/CI mode a piped value is silently ignored and you get an empty variable — pass `--value` explicitly: `vercel env add MIXPANEL_MCP_URL production --value "https://…"`.
   >
   > For a **basic**-auth server (e.g. Langfuse), `mcp-add` → token → `basic`: set `<PREFIX>_MCP_TOKEN` to plaintext `publicKey:secretKey` (the generated file base64-encodes it into `Authorization: Basic …`).

2. In the roster/deploy flow (after the `deskmate sync` line ~230, or near the deploy step ~111), add a line:

   > `deskmate doctor` — before deploying, verify every MCP connection: reachable, authenticated, and its `tools.allow` matches the server's real tools (a mismatch silently loads **zero** tools). Run it after `vercel env pull` so it checks the real production env.

3. Update the `mcp-add` one-liner in the CLI table (~line 229) if you want to mention schemes; optional.

**Step 2: Verify**

Run: `npx markdownlint README.md` if the repo lints docs (check `package.json`); otherwise eyeball the rendered sections. Confirm no broken code fences.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: vercel env add --value trap, deskmate doctor, basic pk:sk convention"
```

---

## Final verification

Run the full suite + typecheck + build from the repo root:

```bash
pnpm -w run build:packages
pnpm --filter @deskmate/cli test
pnpm --filter @deskmate/cli typecheck
```

Expected: all green. Then a manual smoke test of `deskmate doctor` against a real connection (with `vercel env pull` first) is the true end-to-end check — use the `/verify` skill to drive it.

## Out of scope (do not build)

- Live `tools/list` introspection inside `mcp-add`.
- Auto-running `doctor` inside `deploy`.
- Editing catalog allow-lists.
- SSE-only (GET-stream) MCP transport in the probe.
