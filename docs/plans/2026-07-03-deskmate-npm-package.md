# Deskmate npm Package Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Turn this repo into a pnpm monorepo that publishes `@deskmate/core` (engine) + a `deskmate` CLI, so a consumer configures a deployable Eve app from a single `deskmate.config.ts` instead of forking the repo.

**Architecture:** `@deskmate/core` holds all engine logic with a small public API. A consumer writes `deskmate.config.ts` (`defineTeam(...)`); `deskmate sync` generates the `agent/**` tree Eve discovers at build time (committed, prebuild step). The `catalog` (copy-from content bundled in the CLI) seeds editable roles. Core functions are parameterized by the roster — they never import consumer-generated files.

**Tech Stack:** pnpm workspaces, TypeScript (NodeNext), Eve v0.17.1, zod v4, vitest v4, Node 24 native TS type-stripping.

**Design doc:** `docs/plans/2026-07-03-deskmate-npm-package-design.md`

**Note on execution:** consider running in a git worktree. Respect the user's "don't auto-commit" preference — the commit steps below are part of the plan; confirm with the user before the first commit if unsure.

---

## Task 0: pnpm workspace scaffold

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json` (root → workspace root)
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`, `packages/cli/package.json`, `packages/catalog/package.json`, `examples/starter/package.json`
- Create: `packages/core/tsconfig.json`, `packages/cli/tsconfig.json`, `examples/starter/tsconfig.json`

**Step 1: Create the workspace manifest**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "examples/*"
```

**Step 2: Rewrite root `package.json` as a private workspace root**

```json
{
  "name": "deskmate-monorepo",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.28.2",
  "engines": { "node": "24.x" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build:example": "pnpm --filter starter build"
  },
  "devDependencies": { "@types/node": "24.x", "typescript": "7.0.1-rc", "vitest": "^4.1.9" }
}
```

**Step 3: Extract a shared `tsconfig.base.json`** from the current `tsconfig.json` compilerOptions (target ES2022, module/moduleResolution NodeNext, strict, esModuleInterop, skipLibCheck, noEmit). Each package `tsconfig.json` extends it with its own `include`.

**Step 4: Stub the four package manifests.**
- `packages/core/package.json`: name `@deskmate/core`, `type: module`, `exports` map (`.` → `./src/index.ts`, `./channels/*`, etc.), deps `eve`, `ai`, `zod`, `@vercel/connect`; script `typecheck`, `test`.
- `packages/cli/package.json`: name `deskmate`, `bin: { "deskmate": "./src/cli.ts" }`, dep `@deskmate/core` (`workspace:*`); `files` includes bundled `catalog` content (see Task 5).
- `packages/catalog/package.json`: name `@deskmate/catalog`, `private: true` (content-only; not published — CLI bundles it).
- `examples/starter/package.json`: name `starter`, `private: true`, dep `@deskmate/core` + `deskmate` (`workspace:*`), script `build: "deskmate sync && eve build"`.

**Step 5: Verify the workspace links**

Run: `pnpm install`
Expected: installs, links `@deskmate/*` and `deskmate` across the workspace, no errors.

Run: `pnpm -r typecheck`
Expected: passes (empty/stub packages typecheck clean).

**Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json packages examples
git commit -m "chore: scaffold pnpm monorepo (core, cli, catalog, examples/starter)"
```

**Acceptance:**
- [ ] `pnpm install` links the workspace
- [ ] `pnpm -r typecheck` passes
- [ ] four packages exist with correct names + deps

---

## Task 1: Relocate engine code into `@deskmate/core` (roster-parameterized)

The key refactor: core must **not** import a fixed `./deskmates.js` registry (that file becomes consumer-generated). Identity/roster helpers take the roster as a parameter.

**Files:**
- Move: `agent/lib/convene.ts` → `packages/core/src/convene.ts`
- Move: `agent/lib/deskmate-avatars.ts` → `packages/core/src/deskmate-avatars.ts`
- Move: `agent/lib/channel-routes.ts` → `packages/core/src/channel-routes.ts`
- Move: `agent/tools/deskmate_says.ts` → `packages/core/src/deskmate-says.ts`
- Move: `agent/channels/*` → `packages/core/src/channels/*`
- Modify → move: `agent/lib/deskmate-identity.ts` → `packages/core/src/deskmate-identity.ts`
- Create: `packages/core/src/roster.ts` (the `DeskmateIdentity`/roster types, previously in the generated `deskmates.ts`)
- Create: `packages/core/src/index.ts`
- Move tests: `tests/{convene,deskmate_says,deskmate-identity,channel-routes}.test.ts` → `packages/core/test/`

**Step 1: Define the roster type in core** (`packages/core/src/roster.ts`)

```ts
export type DeskmateIdentity = {
  id: string;
  displayName: string;
  emoji: string;
  summary: string;
  providers: string[];
};
export type Roster = Record<string, DeskmateIdentity>;
```

**Step 2: Refactor `deskmate-identity.ts` to take `roster` as a parameter**

Change signatures from reading a module-level `DESKMATES` to accepting `roster: Roster`:
```ts
export function deskmateSlackIdentity(roster: Roster, id: string | null | undefined): SlackSenderIdentity | null { … }
export function deskmateRoster(roster: Roster, excludeId?: string): string { … }
```
Keep `publicBaseUrl`, `chunkMarkdown`, `hasAvatar` wiring intact. `deskmate-avatars.ts` avatar lookup likewise takes the set of ids (or stays a static asset map — keep as-is if it doesn't depend on the registry).

**Step 3: Update the moved tests to pass a fixture roster**

`packages/core/test/deskmate-identity.test.ts`: build a small `const roster: Roster = { devops: {...}, product_analyst: {...} }` fixture and call `deskmateSlackIdentity(roster, "devops")`, `deskmateRoster(roster)`.

**Step 4: Author `packages/core/src/index.ts` (the public API)**

```ts
export { defineTeam } from "./config.js";        // Task 2
export { defineDeskmate } from "./deskmate.js";  // Task 3
export type { TeamConfig, DeskmateConfig, ConnectionConfig } from "./config.js";
export type { Roster, DeskmateIdentity } from "./roster.js";
export { deskmateSlackIdentity, deskmateRoster, chunkMarkdown } from "./deskmate-identity.js";
export { resolveRoute, type ChannelRoute } from "./channel-routes.js";
export { conveneTurnDecision } from "./convene.js"; // keep existing export name
```

**Step 5: Run the moved core tests**

Run: `pnpm --filter @deskmate/core test`
Expected: PASS (the pure logic is unchanged; only signatures/imports adjusted).

**Step 6: Commit**

```bash
git add packages/core agent
git commit -m "feat(core): relocate engine into @deskmate/core, roster-parameterized identity"
```

**Acceptance:**
- [ ] core builds + typechecks with no import of a generated `deskmates.ts`
- [ ] moved tests pass with a fixture roster
- [ ] `index.ts` exports the public API

---

## Task 2: `defineTeam` + config schema (TDD)

**Files:**
- Create: `packages/core/src/config.ts`
- Create: `packages/core/test/config.test.ts`

**Step 1: Write the failing test** (`packages/core/test/config.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";

describe("defineTeam", () => {
  it("applies defaults (maxTurns 6) and returns a normalized team", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer", summary: "…", reads: ["github"] } },
      connections: { github: { kind: "mcp", env: "GITHUB", repo: "acme/app" } },
    });
    expect(team.frontDesk.maxTurns).toBe(6);
    expect(team.deskmates.devops.reads).toEqual(["github"]);
    expect(Object.keys(team.connections)).toContain("github");
  });

  it("rejects a deskmate whose `reads` names an unknown connection", () => {
    expect(() =>
      defineTeam({
        deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["nope"] } },
        connections: {},
      }),
    ).toThrow(/unknown connection/i);
  });

  it("rejects a channel route pointing at an unknown deskmate", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: {},
        channels: { C1: { deskmate: "ghost" } },
      }),
    ).toThrow(/unknown deskmate/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/core test config`
Expected: FAIL ("defineTeam is not a function").

**Step 3: Implement `config.ts`**

```ts
import { z } from "zod";

const ConnectionConfig = z.object({
  kind: z.enum(["mcp", "tool"]),
  env: z.string().optional(),      // env prefix → <ENV>_MCP_URL/_TOKEN for kind:"mcp"
  repo: z.string().optional(),
  from: z.string().optional(),     // module path for kind:"tool"
  apps: z.array(z.string()).optional(),
}).passthrough();

const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
  instructions: z.string().optional(), // path override; defaults to roles/<id>/instructions.md
  tools: z.array(z.string()).optional(),
});

const ChannelRoute = z.object({ deskmate: z.string(), lock: z.boolean().optional() });

const TeamConfig = z.object({
  model: z.string().default("anthropic/claude-sonnet-4.6"),
  frontDesk: z.object({ maxTurns: z.number().int().positive().default(6) }).default({}),
  connections: z.record(z.string(), ConnectionConfig).default({}),
  deskmates: z.record(z.string(), DeskmateConfig).default({}),
  channels: z.record(z.string(), ChannelRoute).default({}),
});

export type TeamConfig = z.infer<typeof TeamConfig>;
export type DeskmateConfig = z.infer<typeof DeskmateConfig>;
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

export function defineTeam(input: unknown): TeamConfig {
  const team = TeamConfig.parse(input);
  for (const [id, d] of Object.entries(team.deskmates)) {
    for (const r of d.reads) {
      if (!team.connections[r]) throw new Error(`deskmate "${id}" reads unknown connection "${r}"`);
    }
  }
  for (const [ch, route] of Object.entries(team.channels)) {
    if (!team.deskmates[route.deskmate]) throw new Error(`channel "${ch}" routes to unknown deskmate "${route.deskmate}"`);
  }
  return team;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/core test config`
Expected: PASS (3 tests).

**Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): defineTeam config schema + cross-reference validation"
```

**Acceptance:**
- [ ] defaults applied; unknown connection/deskmate references rejected
- [ ] `TeamConfig`/`DeskmateConfig`/`ConnectionConfig` types exported

---

## Task 3: `defineDeskmate` (TDD)

**Files:**
- Create: `packages/core/src/deskmate.ts`
- Create: `packages/core/test/deskmate.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";
import { deskmateAgentConfig } from "../src/deskmate.js"; // pure helper under defineDeskmate

const team = defineTeam({
  model: "anthropic/claude-opus-4.8",
  deskmates: {
    devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer",
              summary: "Triages incidents; proposes fixes.", reads: [] },
  },
  connections: {},
});

describe("deskmateAgentConfig", () => {
  it("builds a routing description from summary and falls back to team model", () => {
    const cfg = deskmateAgentConfig(team, "devops");
    expect(cfg.model).toBe("anthropic/claude-opus-4.8");
    expect(cfg.description).toMatch(/DevOps Engineer/);
    expect(cfg.description).toMatch(/Triages incidents/);
  });
  it("throws on unknown id", () => {
    expect(() => deskmateAgentConfig(team, "ghost")).toThrow(/unknown deskmate/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/core test deskmate`
Expected: FAIL.

**Step 3: Implement `deskmate.ts`**

```ts
import { defineAgent } from "eve";
import type { TeamConfig } from "./config.js";

/** Pure: derive the defineAgent config (description = routing hint) for a deskmate id. */
export function deskmateAgentConfig(team: TeamConfig, id: string): { description: string; model: string } {
  const d = team.deskmates[id];
  if (!d) throw new Error(`unknown deskmate "${id}"`);
  const description = `${d.emoji} ${d.displayName}. ${d.summary} Delegate here for ${d.role.replace(/_/g, " ")} questions.`;
  return { description, model: d.model ?? team.model };
}

/** Used inside a generated agent/subagents/<id>/agent.ts shim. */
export function defineDeskmate(team: TeamConfig, id: string) {
  return defineAgent(deskmateAgentConfig(team, id));
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/core test deskmate`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/deskmate.ts packages/core/test/deskmate.test.ts
git commit -m "feat(core): defineDeskmate builds routing description from config"
```

**Acceptance:**
- [ ] description built from emoji/displayName/summary/role
- [ ] per-deskmate model override, else team default
- [ ] unknown id throws

---

## Task 4: Relocate the catalog (roles + connection examples)

**Files:**
- Move: `library/deskmates/*` → `packages/catalog/roles/*`
- Create: `packages/catalog/connections/{mixpanel,sentry,intercom,posthog,linear}.ts` (lift the existing per-role connection files into a shared, generic examples folder)
- Move tests: `tests/{get_incident_summary,get_metric_snapshot,get_account_health,get_funnel_snapshot,get_sprint_status,record_decision}.test.ts` → `packages/catalog/test/` (fix relative imports)
- Modify: each `packages/catalog/roles/<id>/deskmate.json` → the "starter config entry" (keep `id,displayName,emoji,summary,skill,providers`; the CLI uses it to append to `deskmate.config.ts`)

**Step 1:** Move the five role directories verbatim (`git mv`), preserving `agent.ts`, `instructions.md`, `tools/`, `connections/`, `skills/`.

**Step 2:** Update moved test imports (e.g. `../library/deskmates/devops/tools/get_incident_summary.js` → `../roles/devops/tools/get_incident_summary.js`).

**Step 3: Run the moved catalog tests**

Run: `pnpm --filter @deskmate/catalog test`
Expected: PASS (all relocated tool-logic tests green — behavior unchanged).

**Step 4: Commit**

```bash
git add packages/catalog library tests
git commit -m "feat(catalog): relocate the 5 library roles + connection examples"
```

**Acceptance:**
- [ ] five roles live under `packages/catalog/roles/`
- [ ] relocated tool-logic tests pass
- [ ] each role ships a `deskmate.json` starter entry

---

## Task 5: `deskmate` CLI — `add` (scaffold editable) + `mcp-add`

Retarget the current `scripts/deskmate.ts`: `add` now copies a catalog role into the consumer's **editable** space and appends a config entry (not into `agent/subagents`).

**Files:**
- Create: `packages/cli/src/cli.ts` (arg dispatch)
- Create: `packages/cli/src/add.ts`, `packages/cli/src/catalog.ts` (resolve bundled catalog path), `packages/cli/src/config-file.ts` (read/append `deskmate.config.ts` entries)
- Move: `scripts/lib/{env,mcp-template}.ts` → `packages/cli/src/lib/`
- Create: `packages/cli/test/config-file.test.ts`, `packages/cli/test/catalog.test.ts`

**Step 1: Write failing tests for the pure bits**
- `appendDeskmateEntry(configSource, id, entry)` returns config text with a new `deskmates.<id>` key inserted (idempotent: no-op if present).
- `resolveCatalogRoot()` returns a dir that contains `roles/`.

**Step 2:** Run → FAIL.

**Step 3: Implement**
- `catalog.ts`: resolve `roles/` relative to the CLI package (`packages/catalog` in the workspace; bundled `catalog/` when published — check both).
- `add.ts`: `cpSync(roles/<id> → ./roles/<id>)`; read `deskmate.config.ts`, call `appendDeskmateEntry` using the role's `deskmate.json` for identity + `providers`→`reads` + `skill`; write back. Also seed any referenced connection example into `./connections/`.
- `config-file.ts`: string-level insert into the `deskmates: { … }` object (keep it dumb + tested; AST optional later).
- `mcp-add`: keep the existing behavior but write into `./connections/<name>.ts` and append the connection to `deskmate.config.ts` (reuse `renderMcpConnection`).

**Step 4:** Run tests → PASS.

**Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): deskmate add scaffolds editable role + appends config entry"
```

**Acceptance:**
- [ ] `deskmate add devops` copies `roles/devops/` locally + adds a `deskmates.devops` config entry
- [ ] idempotent; `config-file`/`catalog` unit tests pass

---

## Task 6: `deskmate` CLI — `sync` generator (TDD, the heart)

Split into pure renderers + a file-plan, then the imperative writer. Everything testable is pure.

**Files:**
- Create: `packages/cli/src/sync/render.ts` (pure renderers)
- Create: `packages/cli/src/sync/plan.ts` (`planSync(team, cwd)` → `{ writes: {path,contents}[], deletes: string[] }`)
- Create: `packages/cli/src/sync/index.ts` (`syncCommand` — load config, plan, apply)
- Create: `packages/cli/test/render.test.ts`, `packages/cli/test/plan.test.ts`

### Task 6a: Renderers (TDD)

**Step 1: Write failing tests** (`render.test.ts`) for:
- `renderSubagentAgent(id)` → contains the GENERATED banner + `defineDeskmate(team, "devops")` + import of `@deskmate/core` + `deskmate.config`.
- `renderMcpConnectionFromConfig("posthog", { kind:"mcp", env:"POSTHOG" })` → env-driven `defineMcpClientConnection` reading `POSTHOG_MCP_URL`/`POSTHOG_MCP_TOKEN` (reuse the existing `renderMcpConnection` shape).
- `renderRosterRegistry(team)` → the `DESKMATES` const (same shape as today's generated `agent/lib/deskmates.ts`).
- `renderRootAgent(team)` → `defineAgent({ model })` from `team.model`.

**Step 2:** Run → FAIL.

**Step 3: Implement `render.ts`** — pure functions returning strings, each prefixed:
```
// GENERATED by `deskmate sync` — edit deskmate.config.ts instead.
```
Reuse `renderMcpConnection` from `./lib/mcp-template.js` for MCP connections. `renderSubagentAgent` emits the shim from the design (imports `@deskmate/core` + relative `deskmate.config`).

**Step 4:** Run → PASS.

**Step 5: Commit** (`feat(cli): sync renderers`).

### Task 6b: File plan + idempotency + cleanup (TDD)

**Step 1: Write failing tests** (`plan.test.ts`):
- `planSync(team, cwd)` for a 2-deskmate team writes `agent/agent.ts`, `agent/instructions.md`, `agent/lib/deskmates.ts`, and per deskmate `agent/subagents/<id>/{agent.ts,instructions.md,connections/*.ts, tools/*.ts}`.
- Instructions file contents equal the authored `roles/<id>/instructions.md` **verbatim** (read from disk; no composition).
- A deskmate present on disk but absent from config appears in `deletes` (remove cleanup).
- Re-running with the same inputs yields identical `writes` (idempotent).

**Step 2:** Run → FAIL.

**Step 3: Implement `plan.ts`** — build the write list from `team`; read authored instructions/tools from the consumer's `roles/`/`tools/`; diff against the existing `agent/subagents/*` dirs to compute `deletes`. Tools become re-export shims to the authored `../../../../tools/<name>.js`.

**Step 4:** Run → PASS.

**Step 5: Commit** (`feat(cli): sync file plan with idempotency + remove cleanup`).

### Task 6c: Wire `syncCommand` + prebuild

**Step 1:** Implement `sync/index.ts`: dynamically import the consumer's `deskmate.config.ts` (default export = a `TeamConfig` from `defineTeam`), call `planSync`, apply writes (`mkdirSync`/`writeFileSync`) and deletes (`rmSync`), regenerate `.env.example` from connection env keys.
**Step 2:** Wire `cli.ts` dispatch: `add|remove|list|init|mcp-add|sync`.
**Step 3:** Manual check in `examples/starter` (Task 7) via the smoke test.
**Step 4: Commit** (`feat(cli): deskmate sync command`).

**Acceptance:**
- [ ] renderers + plan are pure and unit-tested
- [ ] `sync` is idempotent and removes stale subagent dirs
- [ ] instructions are copied verbatim (no composition)
- [ ] `.env.example` regenerated from config

---

## Task 7: Convert the root app into `examples/starter`

**Files:**
- Create: `examples/starter/deskmate.config.ts`
- Create: `examples/starter/roles/{product_analyst,devops}/…` (via `deskmate add`)
- Create: `examples/starter/agent/**` (via `deskmate sync`)
- Create: `examples/starter/.env.example`, `examples/starter/vercel.json` (from the current root)
- Delete: hand-authored `agent/subagents/*` at repo root (now generated in the example)
- Create: `examples/starter/test/smoke.test.ts`

**Step 1:** Author `examples/starter/deskmate.config.ts` reproducing today's active roster (product_analyst + devops), their connections (mixpanel, sentry) and model.

**Step 2:** `cd examples/starter && deskmate add product_analyst devops` then `deskmate sync`.

**Step 3: Write the smoke test** — assert the generated tree exists and matches the config:
```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
describe("starter sync output", () => {
  it("generated the expected subagents", () => {
    expect(existsSync("agent/subagents/devops/agent.ts")).toBe(true);
    expect(existsSync("agent/subagents/product_analyst/agent.ts")).toBe(true);
  });
});
```

**Step 4: Run the pipeline**

Run: `pnpm --filter starter exec deskmate sync && pnpm --filter starter exec tsc`
Expected: sync writes the tree; typecheck passes. (`eve build` requires Vercel/env — run it if the env allows; otherwise typecheck + `eve build --dry` is the gate.)

**Step 5: Commit** (`feat(example): starter app driven by deskmate.config.ts`).

**Acceptance:**
- [ ] `deskmate sync && <typecheck/build>` is clean in the example
- [ ] root hand-authored subagents removed; example is fully config-driven

---

## Task 8: Test sweep + CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: any leftover `tests/*` at root (should all be moved by now)

**Step 1:** Confirm all 14 original tests moved (core + catalog) and pass: `pnpm -r test`.
**Step 2:** Add CI: `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm build:example` (sync + typecheck) on Node 24.
**Step 3: Commit** (`ci: workspace typecheck + test + build example`).

**Acceptance:**
- [ ] `pnpm -r test` green (original 14 + new sync/config/deskmate tests)
- [ ] CI runs the full matrix

---

## Task 9: README + docs

**Files:**
- Modify: `README.md` (install → configure → sync → deploy flow; remove fork-first framing)
- Modify: `AGENTS.md`/`CLAUDE.md` if package layout paths changed
- Modify: `docs/plans/2026-07-02-addmein-roster-design.md` — add a one-line note that AddMeIn is now a config-only consumer per the npm-package design

**Step 1:** Rewrite the README Quickstart to: `npm i @deskmate/core deskmate` → write `deskmate.config.ts` → `deskmate add <role>` → `deskmate sync` → `eve deploy`. Keep the human-in-the-loop, channel-routing, and Slack-setup sections, updating paths.
**Step 2: Commit** (`docs: README for the import + configure flow`).

**Acceptance:**
- [ ] README describes the package flow, not the fork flow
- [ ] no stale paths to `library/` or `scripts/deskmate.ts`

---

## Suggested order & parallelism

0 → 1 → (2, 3 after 1) → 4 → 5 (after 4) → 6 (after 2,3,5) → 7 (after 6) → 8 (after 7) → 9 (after 7).
Tasks 2 and 3 can run in parallel once 1 lands. Task 4 can run in parallel with 1–3.
