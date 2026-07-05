# OAuth MCP Connections Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Let a deskmate team declare app-scoped OAuth (Vercel Connect) MCP connections in `deskmate.config.ts`, scaffold them with `deskmate mcp-add`, and provision them with a new `deskmate connect` command.

**Architecture:** Eve already implements OAuth via `connect()` from `@vercel/connect/eve` (app-scoped = `connect({ connector, principalType: "app" })`, non-interactive). This plan only extends deskmate's own layer: a `connect`/`service` pair on the connection config (mutually exclusive with the token `env`), an `oauth` branch in the scaffolder, a `connect`-flavored template + stub, `.env.example` awareness, and a `deskmate connect` command that shells out to the Vercel CLI (same DI seam `deskmate deploy` uses).

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, Vitest, pnpm workspaces (`@deskmate/core`, `@deskmate/cli`), `@vercel/connect@0.3.2` (already a dependency of core + starter).

**Design doc:** `docs/plans/2026-07-05-oauth-mcp-connections-design.md`

**Native task mapping:** Task 1→#7, Task 2+3→#8, Task 4→#10, Task 5→#9, Task 6→#11, Task 7→#12.

**Conventions used below**
- Run a single CLI test file: `pnpm --filter @deskmate/cli exec vitest run test/<file>`
- Run a single core test file: `pnpm --filter @deskmate/core exec vitest run test/<file>`
- Full suite: `pnpm test` · Typecheck: `pnpm typecheck`
- Commit after each task once its tests are green (frequent commits). This branch has no design-doc commit yet — the first task's commit can include both design docs.

---

## Task 1: Config model — `connect` + `service` fields (native #7)

**Files:**
- Modify: `packages/core/src/config.ts:3-6` (the `ConnectionConfig` schema)
- Test: `packages/core/test/config.test.ts`

**Step 1: Write the failing tests**

Add to `packages/core/test/config.test.ts` (inside the `describe("defineTeam", …)` block):

```ts
it("accepts an oauth connection with connect + service", () => {
  const team = defineTeam({
    deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["vercel"] } },
    connections: { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
  });
  expect(team.connections.vercel).toMatchObject({ kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" });
});

it("rejects a connection that sets both env (token) and connect (oauth)", () => {
  expect(() =>
    defineTeam({
      deskmates: {},
      connections: { bad: { kind: "mcp", env: "BAD", connect: "bad/deskmate" } },
    }),
  ).toThrow(/either .*env.* or .*connect/i);
});

it("rejects `service` without `connect`", () => {
  expect(() =>
    defineTeam({
      deskmates: {},
      connections: { bad: { kind: "mcp", env: "BAD", service: "mcp.bad.com" } },
    }),
  ).toThrow(/service.*only.*connect/i);
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @deskmate/core exec vitest run test/config.test.ts`
Expected: FAIL — the oauth case throws "unrecognized key" / the reject cases don't throw the new messages.

**Step 3: Update the schema**

In `packages/core/src/config.ts`, replace the `ConnectionConfig` definition (lines 3-6):

```ts
const ConnectionConfig = z
  .object({
    kind: z.literal("mcp"),
    env: z.string().optional(), // token model → <ENV>_MCP_URL/_TOKEN
    connect: z.string().optional(), // oauth model → app-scoped Vercel Connect connector UID
    service: z.string().optional(), // oauth model → Connect service id for `vercel connect create`
  })
  .refine((c) => !(c.env && c.connect), {
    message: "a connection uses either `env` (token) or `connect` (oauth), not both",
  })
  .refine((c) => !(c.service && !c.connect), {
    message: "`service` only applies to an oauth (`connect`) connection",
  });
```

Leave `TeamConfig`, `defineTeam`, and the exported `ConnectionConfig` type inference as-is — `z.infer` picks up the new optional fields, and `z.record(z.string(), ConnectionConfig)` accepts the refined (ZodEffects) schema unchanged.

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @deskmate/core exec vitest run test/config.test.ts`
Expected: PASS (all cases, including the pre-existing ones).

**Step 5: Typecheck core**

Run: `pnpm --filter @deskmate/core typecheck`
Expected: no errors.

**Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts docs/plans/2026-07-05-oauth-mcp-connections*.md
git commit -m "feat(core): allow oauth (Vercel Connect) MCP connections in team config"
```

---

## Task 2: Connect template renderer (part of native #8)

**Files:**
- Modify: `packages/cli/src/lib/mcp-template.ts` (add a second renderer; keep `renderMcpConnection` unchanged)
- Test: `packages/cli/test/mcp-template.test.ts`

**Step 1: Write the failing test**

Add to `packages/cli/test/mcp-template.test.ts`:

```ts
import { renderMcpConnection, renderConnectConnection } from "../src/lib/mcp-template.js";

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
    // No token/env plumbing on the oauth path.
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
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/cli exec vitest run test/mcp-template.test.ts`
Expected: FAIL — `renderConnectConnection` is not exported.

**Step 3: Add the renderer**

Append to `packages/cli/src/lib/mcp-template.ts`:

```ts
export type ConnectTemplateOptions = {
  name: string;
  connector: string; // Vercel Connect connector UID, e.g. "vercel/deskmate"
  url: string; // the MCP runtime endpoint, e.g. "https://mcp.vercel.com"
  description: string;
  tools: string[];
};

/** Pure: render an app-scoped Vercel Connect (OAuth) MCP connection. */
export function renderConnectConnection(opts: ConnectTemplateOptions): string {
  const allow = opts.tools.map((t) => JSON.stringify(t)).join(", ");
  return `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

// Generated by \`deskmate mcp-add\` (oauth). App-scoped Vercel Connect: the deskmate
// acts as itself (non-interactive). Provision the connector with \`deskmate connect ${opts.name}\`.
export default defineMcpClientConnection({
  url: ${JSON.stringify(opts.url)},
  description: ${JSON.stringify(opts.description)},
  auth: connect({ connector: ${JSON.stringify(opts.connector)}, principalType: "app" }),
  tools: { allow: [${allow}] },
});
`;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/cli exec vitest run test/mcp-template.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/cli/src/lib/mcp-template.ts packages/cli/test/mcp-template.test.ts
git commit -m "feat(cli): render app-scoped Vercel Connect MCP connections"
```

---

## Task 3: `mcp-add` oauth branch (part of native #8)

**Files:**
- Modify: `packages/cli/src/mcp-add.ts` (extract a testable oauth scaffolder + add the prompt branch)
- Test: `packages/cli/test/mcp-add.test.ts` (new)

**Step 1: Write the failing test**

Create `packages/cli/test/mcp-add.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldConnectConnection } from "../src/mcp-add.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmate-mcpadd-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spec = {
  name: "vercel",
  connector: "vercel/deskmate",
  service: "mcp.vercel.com",
  url: "https://mcp.vercel.com",
  description: "Vercel (read-only).",
  tools: ["list_deployments"],
};

describe("scaffoldConnectConnection", () => {
  it("writes an app-scoped connect() connection file", () => {
    scaffoldConnectConnection(spec, dir);
    const file = join(dir, "connections", "vercel.ts");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain('import { connect } from "@vercel/connect/eve";');
    expect(src).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
  });

  it("appends a { kind:'mcp', connect, service } entry to deskmate.config.ts", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(
      cfg,
      `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`,
    );
    scaffoldConnectConnection(spec, dir);
    const src = readFileSync(cfg, "utf8");
    expect(src).toContain('vercel: {');
    expect(src).toContain('"kind": "mcp"');
    expect(src).toContain('"connect": "vercel/deskmate"');
    expect(src).toContain('"service": "mcp.vercel.com"');
  });

  it("never clobbers an existing connection file", () => {
    const file = join(dir, "connections", "vercel.ts");
    writeFileSync(join(dir, "connections"), ""); // ensure mkdir path; replaced below
    rmSync(join(dir, "connections"), { force: true });
    scaffoldConnectConnection(spec, dir);
    writeFileSync(file, "// hand-edited\n");
    scaffoldConnectConnection(spec, dir); // second call must skip
    expect(readFileSync(file, "utf8")).toBe("// hand-edited\n");
  });
});
```

> Note: `renderEntry` JSON-encodes values, so config keys appear quoted (`"kind": "mcp"`). That matches the existing token entries written by `appendConnectionEntry`.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/cli exec vitest run test/mcp-add.test.ts`
Expected: FAIL — `scaffoldConnectConnection` is not exported.

**Step 3: Extract the oauth scaffolder + add imports**

In `packages/cli/src/mcp-add.ts`, update the import from the template lib (line 4):

```ts
import { renderMcpConnection, renderConnectConnection } from "./lib/mcp-template.js";
```

Add this exported function (place it above `mcpAdd`):

```ts
/**
 * Scaffold an app-scoped OAuth (Vercel Connect) MCP connection: write
 * `./connections/<name>.ts` and append a `{ kind:"mcp", connect, service }` entry
 * to `./deskmate.config.ts`. Never clobbers an existing connection file.
 */
export function scaffoldConnectConnection(
  spec: { name: string; connector: string; service: string; url: string; description: string; tools: string[] },
  cwd: string,
): void {
  const file = join(cwd, "connections", `${spec.name}.ts`);
  if (existsSync(file)) {
    console.log(`• ${spec.name}: connections/${spec.name}.ts already exists, skipping (edit it directly, or remove it first)`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderConnectConnection(spec));
  console.log(`✓ created connections/${spec.name}.ts`);

  const entry = { kind: "mcp", connect: spec.connector, service: spec.service };
  editConfig(
    cwd,
    spec.name,
    (s) => appendConnectionEntry(s, spec.name, entry),
    renderEntry(spec.name, entry),
    `${spec.name}: already in connections`,
  );
  console.log(`  provision it with \`deskmate connect ${spec.name}\`.`);
}
```

**Step 4: Add the prompt branch in `mcpAdd`**

In `mcpAdd`, wrap the existing prompt body with an auth-mode branch. Immediately inside `withPrompts(async (ask) => {`, before the current `const urlEnv = …`:

```ts
    const mode = (await ask("Auth [token/oauth]", "token")).toLowerCase();
    if (mode === "oauth") {
      const connector = await ask("Connector UID", `${name}/deskmate`);
      const url = await ask("MCP URL", `https://mcp.${name}.com`);
      let serviceDefault = "";
      try { serviceDefault = new URL(url).host; } catch { serviceDefault = ""; }
      const service = await ask("Connect service id", serviceDefault);
      const description = await ask("Description (for the model)", `${name} (OAuth MCP).`);
      const toolsRaw = await ask("Read tools (comma-separated)", "");
      const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      scaffoldConnectConnection({ name, connector, service, url, description, tools }, cwd);
      return;
    }
    // ── token path (unchanged) ─────────────────────────────────────────────
```

The existing token path (`const urlEnv = …` through the end) stays exactly as-is below this block.

**Step 5: Run test to verify it passes**

Run: `pnpm --filter @deskmate/cli exec vitest run test/mcp-add.test.ts`
Expected: PASS.

**Step 6: Typecheck the CLI**

Run: `pnpm --filter @deskmate/cli typecheck`
Expected: no errors.

**Step 7: Commit**

```bash
git add packages/cli/src/mcp-add.ts packages/cli/test/mcp-add.test.ts
git commit -m "feat(cli): add oauth branch to deskmate mcp-add"
```

---

## Task 4: Renderer touch-ups — `.env.example` + connect stub (native #10)

**Files:**
- Modify: `packages/cli/src/sync/render.ts` (`renderEnvExample`, `renderStubConnection`)
- Modify: `packages/cli/src/sync/plan.ts` (the single `renderStubConnection` call site)
- Test: `packages/cli/test/render.test.ts`

**Step 1: Write the failing tests**

In `packages/cli/test/render.test.ts`, extend the `fixtureTeam.connections` (around line 26) to include an oauth connection:

```ts
  connections: {
    sentry: { kind: "mcp", env: "SENTRY" },
    mixpanel: { kind: "mcp", env: "MIXPANEL" },
    vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" },
    ledger: { kind: "tool", from: "./ledger.js" },
  },
```

Add to `describe("renderEnvExample", …)`:

```ts
  it("lists oauth connections in a Vercel Connect block, without URL/TOKEN vars", () => {
    const out = renderEnvExample(fixtureTeam);
    expect(out).not.toContain("VERCEL_MCP_URL=");
    expect(out).not.toContain("VERCEL_MCP_TOKEN=");
    expect(out).toContain("OAuth connections (Vercel Connect)");
    expect(out).toContain("vercel");
    expect(out).toContain("vercel/deskmate");
    expect(out).toContain("deskmate connect vercel");
  });
```

Update the existing two `renderStubConnection` tests to the new `(name, conn?)` signature and add an oauth-stub test:

```ts
describe("renderStubConnection", () => {
  it("reads env vars via bracket access (valid TS even for a non-identifier prefix)", () => {
    const out = renderStubConnection("weird", { env: "123" });
    expect(out).toContain('process.env["123_MCP_URL"]');
    expect(out).toContain('process.env["123_MCP_TOKEN"]');
    expect(out).not.toContain("process.env.123_MCP_URL");
    expect(out).not.toContain("process.env.123_MCP_TOKEN");
  });

  it("derives the env prefix from the name when none is given, still bracketed", () => {
    const out = renderStubConnection("my_conn", undefined);
    expect(out).toContain('process.env["MY_CONN_MCP_URL"]');
    expect(out).toContain('process.env["MY_CONN_MCP_TOKEN"]');
  });

  it("emits an app-scoped connect() stub for an oauth connection", () => {
    const out = renderStubConnection("vercel", { connect: "vercel/deskmate", service: "mcp.vercel.com" });
    expect(out).toContain('import { connect } from "@vercel/connect/eve";');
    expect(out).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
    expect(out).not.toContain("process.env");
    expect(out).toContain("deskmate connect vercel");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @deskmate/cli exec vitest run test/render.test.ts`
Expected: FAIL — no oauth block; `renderStubConnection` still takes a string prefix.

**Step 3: Update `renderStubConnection`**

Replace `renderStubConnection` in `packages/cli/src/sync/render.ts` (lines 201-217) with a signature that takes the connection config and branches on `connect`:

```ts
export function renderStubConnection(
  name: string,
  conn?: { env?: string; connect?: string },
): string {
  if (conn?.connect) {
    return `${BANNER}
// TODO(deskmate sync): no authored connection file found for oauth connection "${name}". Expected one of:
//   roles/<id>/connections/${name}.ts   (deskmate-local)
//   connections/${name}.ts              (shared, at the repo root)
// Scaffold with \`deskmate mcp-add ${name}\` (choose oauth), then \`deskmate connect ${name}\`.
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://example.invalid/mcp",
  description: "TODO: replace this stub — the authored oauth connection for \\"${name}\\" is missing.",
  auth: connect({ connector: ${JSON.stringify(conn.connect)}, principalType: "app" }),
  tools: { allow: [] },
});
`;
  }
  const prefix = conn?.env ?? name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${BANNER}
// TODO(deskmate sync): no authored connection file found for "${name}". Expected one of:
//   roles/<id>/connections/${name}.ts   (deskmate-local)
//   connections/${name}.ts              (shared, at the repo root)
// Scaffold one with \`deskmate mcp-add ${name}\`, then re-run \`deskmate sync\`.
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: process.env[${JSON.stringify(`${prefix}_MCP_URL`)}] ?? "https://example.invalid/mcp",
  description: "TODO: replace this stub — the authored connection for \\"${name}\\" is missing.",
  auth: { getToken: async () => ({ token: process.env[${JSON.stringify(`${prefix}_MCP_TOKEN`)}] ?? "" }) },
  tools: { allow: [] },
});
`;
}
```

**Step 4: Update the caller in `plan.ts`**

In `packages/cli/src/sync/plan.ts` (~line 144), change:

```ts
        contents = renderStubConnection(name, team.connections[name]?.env);
```
to:
```ts
        contents = renderStubConnection(name, team.connections[name]);
```

**Step 5: Add the oauth block to `renderEnvExample`**

In `renderEnvExample` (`render.ts`), after `const blocks = …` / `const body = …` (lines 246-250), before the `return`, add:

```ts
  const oauth = Object.entries(team.connections)
    .filter(([, c]) => c.kind === "mcp" && !!c.connect)
    .map(([name, c]) => `#   ${name} → connector ${c.connect}  (run \`deskmate connect ${name}\`)`);
  const oauthBlock = oauth.length
    ? `\n\n# ── OAuth connections (Vercel Connect) ────────────────────────────────────
# App-scoped Vercel Connect — no URL/token here. Provision each with
# \`deskmate connect <name>\` (runs vercel connect create/attach + vercel env pull):
${oauth.join("\n")}`
    : "";
  return `${preamble}${body}${oauthBlock}\n`;
```

(Replace the existing final `return \`${preamble}${body}\n\`;`.)

**Step 6: Run tests to verify they pass**

Run: `pnpm --filter @deskmate/cli exec vitest run test/render.test.ts`
Expected: PASS.

Then the whole CLI suite (plan.test.ts exercises `renderStubConnection` via `planSync`):

Run: `pnpm --filter @deskmate/cli exec vitest run test/plan.test.ts test/sync.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add packages/cli/src/sync/render.ts packages/cli/src/sync/plan.ts packages/cli/test/render.test.ts
git commit -m "feat(cli): make .env.example + stub renderer oauth-aware"
```

---

## Task 5: `deskmate connect` command (native #9)

**Files:**
- Create: `packages/cli/src/lib/run.ts` (extract `runCommand` for reuse)
- Modify: `packages/cli/src/deploy.ts` (import `runCommand` from lib; re-export for its test)
- Create: `packages/cli/src/lib/load-config.ts` (dynamic-import + `defineTeam`)
- Create: `packages/cli/src/connect.ts`
- Modify: `packages/cli/src/cli.ts` (wire the command + usage line)
- Test: `packages/cli/test/connect.test.ts` (new)

**Step 1: Write the failing test**

Create `packages/cli/test/connect.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { connectCommand, type ConnectDeps } from "../src/connect.js";

function makeDeps(connections: Record<string, unknown>, runCodes: number[] = []) {
  const calls: string[] = [];
  const queue = [...runCodes];
  const deps: ConnectDeps = {
    loadConnections: vi.fn(async () => connections as any),
    run: vi.fn(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return queue.shift() ?? 0;
    }),
  };
  return { deps, calls };
}

describe("connectCommand", () => {
  it("runs vercel connect create → attach → env pull for an oauth connection", async () => {
    const { deps, calls } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } });
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "vercel connect create mcp.vercel.com --name deskmate",
      "vercel connect attach vercel/deskmate --yes",
      "vercel env pull",
    ]);
  });

  it("tolerates a non-zero `create` (connector may already exist) but still attaches", async () => {
    const { deps, calls } = makeDeps(
      { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
      [1, 0, 0], // create fails, attach ok, env pull ok
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls[1]).toBe("vercel connect attach vercel/deskmate --yes");
    vi.restoreAllMocks();
  });

  it("returns the attach exit code when attach fails", async () => {
    const { deps } = makeDeps(
      { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
      [0, 3], // create ok, attach fails
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(3);
    vi.restoreAllMocks();
  });

  it("accepts a service passed as a positional arg when config omits it", async () => {
    const { deps, calls } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate" } });
    const code = await connectCommand(["vercel", "mcp.vercel.com"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls[0]).toBe("vercel connect create mcp.vercel.com --name deskmate");
  });

  it("errors when the connection is not oauth", async () => {
    const { deps } = makeDeps({ sentry: { kind: "mcp", env: "SENTRY" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["sentry"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });

  it("errors when the connection is unknown", async () => {
    const { deps } = makeDeps({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["ghost"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });

  it("errors when no service is available (config + arg both missing)", async () => {
    const { deps } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/cli exec vitest run test/connect.test.ts`
Expected: FAIL — `../src/connect.js` does not exist.

**Step 3: Extract `runCommand` into `lib/run.ts`**

Create `packages/cli/src/lib/run.ts` with the current body of `runCommand` (moved verbatim from `deploy.ts:22-40`):

```ts
import { spawn } from "node:child_process";

/**
 * Run a command to completion, resolving with its exit code. Never hangs and
 * never reports a failed run as success:
 * - a spawn failure (e.g. the Vercel CLI isn't installed / not on PATH) emits
 *   "error", not "exit" → resolve 127 instead of leaving the Promise pending;
 * - a signal-terminated child reports `code === null` → resolve 1 (failure).
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", (err) => {
      console.error(`✗ could not run \`${cmd}\`: ${err instanceof Error ? err.message : String(err)}`);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
```

In `packages/cli/src/deploy.ts`: delete the moved `runCommand` definition + its `import { spawn } …` line, and add near the top:

```ts
import { runCommand } from "./lib/run.js";
```
Then re-export it so `deploy.test.ts` (which imports `runCommand` from `../src/deploy.js`) stays green — add after the imports:

```ts
export { runCommand } from "./lib/run.js";
```
`defaultDeps.run` continues to reference the imported `runCommand`.

**Step 4: Add the config loader `lib/load-config.ts`**

Create `packages/cli/src/lib/load-config.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTeam, type TeamConfig } from "@deskmate/core";

export const CONFIG_FILE = "deskmate.config.ts";

/**
 * Load + validate the consumer's `deskmate.config.ts`. Mirrors `syncCommand`'s
 * dynamic import (needs Node ≥23.6 native type-stripping, or
 * `node --experimental-strip-types`).
 */
export async function loadTeam(cwd: string): Promise<TeamConfig> {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`no ${CONFIG_FILE} found in ${cwd}. Run \`deskmate add <id>\` first.`);
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(configPath).href)) as { default?: unknown };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not load ${CONFIG_FILE} (${reason}). Loading a .ts config needs Node ≥23.6 ` +
        `(native type-stripping) or \`node --experimental-strip-types\`.`,
    );
  }
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`${CONFIG_FILE} must \`export default\` a team config object.`);
  }
  return defineTeam(mod.default);
}
```

**Step 5: Write `connect.ts`**

Create `packages/cli/src/connect.ts`:

```ts
import type { ConnectionConfig } from "@deskmate/core";
import { runCommand } from "./lib/run.js";
import { loadTeam, CONFIG_FILE } from "./lib/load-config.js";

/** Side effects `connectCommand` needs — injected so orchestration is unit-testable. */
export interface ConnectDeps {
  loadConnections: (cwd: string) => Promise<Record<string, ConnectionConfig>>;
  run: (cmd: string, args: string[], cwd: string) => Promise<number>;
}

const defaultDeps: ConnectDeps = {
  loadConnections: async (cwd) => (await loadTeam(cwd)).connections,
  run: runCommand,
};

/**
 * `deskmate connect <name> [service]`: provision the app-scoped Vercel Connect
 * connector for an oauth MCP connection declared in `deskmate.config.ts`:
 *
 *   vercel connect create <service> --name <connector-name>
 *   vercel connect attach <connector-uid> --yes
 *   vercel env pull
 *
 * `service` comes from the connection's `service` field (written by
 * `deskmate mcp-add`) or an explicit positional arg. The connector name is the
 * UID's suffix (after the last `/`). Requires the Vercel CLI installed and
 * authenticated (`vercel login`). Safe to re-run: a `create` that fails because
 * the connector already exists is tolerated; real problems surface at `attach`.
 */
export async function connectCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: ConnectDeps = defaultDeps,
): Promise<number> {
  const name = args[0];
  if (!name) {
    console.error("usage: deskmate connect <name> [service]");
    return 1;
  }
  const connections = await deps.loadConnections(cwd);
  const conn = connections[name];
  if (!conn) {
    console.error(`✗ no connection "${name}" in ${CONFIG_FILE}. Run \`deskmate mcp-add ${name}\` first.`);
    return 1;
  }
  if (!conn.connect) {
    console.error(`✗ connection "${name}" isn't an oauth (connect) connection — nothing to provision.`);
    return 1;
  }
  const uid = conn.connect;
  const service = args[1] ?? conn.service;
  if (!service) {
    console.error(
      `✗ no Connect service for "${name}". Add a \`service\` to the connection in ${CONFIG_FILE}, ` +
        `or pass it: \`deskmate connect ${name} <service>\`.`,
    );
    return 1;
  }
  const connectorName = uid.includes("/") ? uid.slice(uid.lastIndexOf("/") + 1) : uid;

  const createCode = await deps.run("vercel", ["connect", "create", service, "--name", connectorName], cwd);
  if (createCode !== 0) {
    console.log(`  (vercel connect create exited ${createCode} — continuing; the connector may already exist)`);
  }
  const attachCode = await deps.run("vercel", ["connect", "attach", uid, "--yes"], cwd);
  if (attachCode !== 0) {
    console.error(
      `✗ vercel connect attach failed (${attachCode}). If it reports an unknown connector, copy the UID ` +
        `\`vercel connect create\` printed into \`connect:\` for "${name}" in ${CONFIG_FILE}.`,
    );
    return attachCode;
  }
  return deps.run("vercel", ["env", "pull"], cwd);
}
```

**Step 6: Wire it into `cli.ts`**

In `packages/cli/src/cli.ts`:
- Add the import near the others (after `import { deploy } from "./deploy.js";`):
  ```ts
  import { connectCommand } from "./connect.js";
  ```
- Add a usage line in the help array (after the `deskmate deploy` line):
  ```ts
  "  deskmate connect <name>   provision an oauth connection's Vercel Connect connector",
  ```
- Add the case (after `case "deploy":`):
  ```ts
      case "connect":
        process.exitCode = await connectCommand(rest);
        break;
  ```

**Step 7: Run test to verify it passes**

Run: `pnpm --filter @deskmate/cli exec vitest run test/connect.test.ts test/deploy.test.ts`
Expected: PASS (connect green; deploy still green via the re-exported `runCommand`).

**Step 8: Typecheck the CLI**

Run: `pnpm --filter @deskmate/cli typecheck`
Expected: no errors (`ConnectionConfig` now carries `connect`/`service`).

**Step 9: Commit**

```bash
git add packages/cli/src/lib/run.ts packages/cli/src/lib/load-config.ts packages/cli/src/connect.ts packages/cli/src/deploy.ts packages/cli/src/cli.ts packages/cli/test/connect.test.ts
git commit -m "feat(cli): add deskmate connect to provision Vercel Connect connectors"
```

---

## Task 6: Starter example + docs (native #11)

**Files:**
- Modify: `examples/starter/deskmate.config.ts`
- Modify: `README.md` (or the connections section of the docs, wherever `mcp-add` is documented — grep first)

**Step 1: Add a commented oauth example to the starter**

In `examples/starter/deskmate.config.ts`, inside `connections: { … }` (after the `sentry` line), add:

```ts
    // OAuth (Vercel Connect) connection — app-scoped, no URL/token env.
    // Scaffold with `deskmate mcp-add vercel` (choose oauth), then provision with
    // `deskmate connect vercel` (runs vercel connect create/attach + env pull).
    // vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" },
```

**Step 2: Document the oauth flow**

First locate where connections/`mcp-add` are documented:

Run: `grep -rln "mcp-add" README.md docs *.md 2>/dev/null`

In that doc, add an "OAuth (Vercel Connect) connections" subsection near the existing connections docs:

```markdown
### OAuth (Vercel Connect) connections

Some MCP servers (e.g. Vercel, Neon) are OAuth-only. Deskmate supports them with
**app-scoped Vercel Connect** — the deskmate acts as itself (non-interactive), so
there's no per-user consent step. `@vercel/connect` is already a dependency.

1. Scaffold: `deskmate mcp-add vercel` → choose **oauth**, give the connector UID
   (e.g. `vercel/deskmate`), the MCP URL, and the Connect service id. This writes
   `connections/vercel.ts` (using `connect({ …, principalType: "app" })`) and a
   `{ kind: "mcp", connect, service }` entry in `deskmate.config.ts`.
2. Provision: `deskmate connect vercel` runs
   `vercel connect create/attach` + `vercel env pull` for you. Requires the Vercel
   CLI installed and authenticated (`vercel login`) — same prerequisite as
   `deskmate deploy`.
3. `deskmate sync` and deploy as usual.

Token-based (API-key) MCP servers still use the `env` model: `deskmate mcp-add
<name>` → **token**, then set `<PREFIX>_MCP_URL` / `<PREFIX>_MCP_TOKEN`.
```

**Step 3: Commit**

```bash
git add examples/starter/deskmate.config.ts README.md
git commit -m "docs: document oauth (Vercel Connect) MCP connections"
```

---

## Task 7: Full verification & green gate (native #12)

**Files:** none (verification only)

**Step 1: Run the whole test suite**

Run: `pnpm test`
Expected: all packages PASS (core + cli).

**Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: no errors.

**Step 3: Build the packages**

Run: `pnpm build:packages`
Expected: core + cli build clean.

**Step 4: (If Node ≥23.6 available) end-to-end sync + eve build**

The CI/dev environment here is Node 22; a real `.ts`-config sync needs Node ≥23.6.
Where available, in a scratch consumer (or `examples/starter` with an oauth
connection uncommented + a deskmate reading it):

Run: `deskmate sync` then `eve build`
Expected: generated `agent/**` compiles; the oauth connection file (or its
connect-flavored stub) imports `connect` and builds without a URL/token.

If Node ≥23.6 isn't available in this environment, note it and rely on the unit
coverage (render/stub/template/connect tests) plus a manual check post-merge.

**Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test: verify oauth MCP connection path end-to-end"
```

---

## Notes / residual risks

- **Connector UID vs. what `vercel connect create` returns.** `deskmate connect`
  assumes the connector UID equals `<service-alias>/<name>` (the deskmate
  convention, matching `SLACK_CONNECTOR=slack/deskmate`). If Vercel returns a
  different UID, `attach` fails with a clear hint to copy the printed UID into
  `connect:`. This is the one external unknown flagged in the design.
- **Node ≥23.6** is required to load a `.ts` config at runtime (existing
  constraint shared with `deskmate sync`/`dev`). Unit tests inject the loader and
  don't hit it.
- **YAGNI:** user-scoped Connect and auto-wiring addmein's specific Vercel/Neon
  connectors are explicitly out of scope.
