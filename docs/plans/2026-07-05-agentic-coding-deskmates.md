# Agentic-coding deskmates — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Give a deskmate the ability to clone a GitHub repo into its isolated eve sandbox, make a scoped change on a feature branch, run tests, and open a pull request for human review — behind a human-approved push gate, never touching the default branch and never merging.

**Architecture:** A reusable, opt-in `coding` capability (mirroring the existing `memory` opt-in). `coding: true | { repos: [...] }` on a roster entry makes `deskmate sync` emit three things into that subagent's tree: an eve **sandbox** (`defineSandbox`) that locks egress and brokers a GitHub App installation token at the firewall, an **approval-gated `open_pull_request` tool**, and a **coding safety-rules instruction block**. All logic lives in a new `@deskmate/core/coding` submodule (the generated shims just bind it by id — exactly how `@deskmate/core/memory` works). A flagship `engineer` catalog role ships with `coding` enabled. Phase 2 adds eve's root-level `githubChannel` reusing the same App.

**Tech Stack:** TypeScript (NodeNext, ESM, `.js` import specifiers), zod v4, eve `0.19.0` (`eve/sandbox`, `eve/tools`, `eve/tools/approval`, `eve/channels/github`), `@octokit/auth-app` + `@octokit/rest` for App-token minting and PR creation, vitest, pnpm workspace.

**Reference before starting:** the design doc `docs/plans/2026-07-05-agentic-coding-deskmates-design.md`, and the installed eve docs at `node_modules/.pnpm/eve@0.19.0_*/node_modules/eve/docs/{sandbox.mdx,subagents.mdx,tools/overview.mdx,channels/github.mdx}`.

**Skills to use:** @superpowers-extended-cc:test-driven-development for every task; @superpowers-extended-cc:verification-before-completion before each commit.

---

## Key facts the implementer must know (from codebase exploration)

- **Test runner is vitest** (`pnpm --filter <pkg> test` runs `vitest run --passWithNoTests`). Tests live in a sibling `test/` dir per package and import source via `../src/x.js` (NodeNext ⇒ `.js` specifier even for `.ts`).
- **`@deskmate/core` submodule pattern:** a submodule is a folder `src/<name>/` with a barrel `src/<name>/index.ts`, exposed as a **subpath export** in `packages/core/package.json` (`"./coding": { types, default }`) and imported as `@deskmate/core/coding` (NOT via the root `src/index.ts`). Copy the `memory/` submodule shape exactly.
- **The `memory` opt-in is the template.** Config: `d.memory` is `undefined` when off. In `packages/cli/src/sync/plan.ts:177-182`, `if (d.memory) { …emit tool shims + instructions… }`. Do the same with `d.coding`.
- **Renderers are pure string functions** in `packages/cli/src/sync/render.ts`; `plan.ts` calls them via `out(relPath, contents)`; `sync/index.ts` writes files and wipes each `agent/subagents/<id>/` before writing (fresh copies).
- **Subagents may author their own sandbox** (`subagents.mdx:70`): shorthand `agent/subagents/<id>/sandbox.ts` (definition only — what we use, since we clone at runtime rather than seed files). It imports from the bare specifier `@deskmate/core/coding`, so no relative-path depth math is needed (same as the memory tool shim importing `@deskmate/core/memory`).
- **eve exact imports:** `import { defineSandbox, defaultBackend } from "eve/sandbox";` · `import { defineTool } from "eve/tools";` · `import { always } from "eve/tools/approval";` · `const sandbox = await ctx.getSandbox(); await sandbox.run({ command });`.
- **Firewall credential brokering** (`sandbox.mdx:212-223`): `networkPolicy.allow["github.com"] = [{ transform: [{ headers: { authorization: "<scheme> <cred>" } }] }]` with a `"*": []` catch-all to keep general egress. Only `vercel()`/`microsandbox()` honor domain allow-lists + transforms; Docker is allow-all/deny-all only.

## Cross-cutting decisions (do not re-litigate mid-implementation)

1. **Single-org allowlist in Phase 1.** A clone target is chosen at runtime, but `onSession` must broker a token before the model runs. A GitHub App **installation token is per-org**, so Phase 1 requires every entry in `coding.repos` to resolve to one org/installation (e.g. `["acme/*"]` or `["acme/api","acme/web"]`). `defineTeam` validates this. Multi-org is out of scope (noted in the design).
2. **Sandbox gets the brokered install token (read+write to github.com); the human gate is the `approval: always()` on `open_pull_request`.** This matches eve's own GitHub channel (which brokers the install token into the sandbox for push). Raw-bash pushing is forbidden by instructions; the real safety net is branch-per-task + PR-only + human merge under **branch protection** (documented as required setup). The stronger "read-only sandbox + push from runtime via the Git Data API" hardening is a future follow-up, not Phase 1.
3. **The capability injects sandbox + tool + safety instructions for ANY coding deskmate.** The richer `agentic-coding` SKILL playbook is authored in the `engineer` role dir (its flagship skill, copied by the existing skills loop). A non-engineer role that flips on `coding` still gets a working, safe loop from the injected pieces.
4. **`open_pull_request` splits a testable pure helper from the `defineTool` wrapper** (the repo's convention — see `catalog/.../record_decision.ts` importing the named helper in tests). All git/Octokit side effects go through an injected `deps` object.

---

## Task 0: `coding` config schema + `github` team block + validation

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`

**Step 1 — Write failing tests.** Add to `config.test.ts`:

```ts
it("normalizes coding: true to a default (empty repos) object", () => {
  const t = defineTeam({
    github: { org: "acme" },
    deskmates: { engineer: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: true } },
  });
  expect(t.deskmates.engineer.coding).toEqual({ repos: [] });
});

it("keeps an explicit coding.repos allowlist", () => {
  const t = defineTeam({
    github: { org: "acme" },
    deskmates: { eng: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: { repos: ["acme/*"] } } },
  });
  expect(t.deskmates.eng.coding).toEqual({ repos: ["acme/*"] });
});

it("leaves coding undefined when omitted or false", () => {
  const t = defineTeam({ deskmates: { a: { role: "r", emoji: ":x:", displayName: "A", summary: "s", coding: false } } });
  expect(t.deskmates.a.coding).toBeUndefined();
});

it("rejects a coding deskmate when the team has no github block", () => {
  expect(() => defineTeam({
    deskmates: { eng: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: true } },
  })).toThrow(/github/i);
});

it("rejects a coding.repos entry outside the configured github.org", () => {
  expect(() => defineTeam({
    github: { org: "acme" },
    deskmates: { eng: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: { repos: ["other/api"] } } },
  })).toThrow(/single org|acme/i);
});
```

**Step 2 — Run, verify fail:** `pnpm --filter @deskmate/core test` → the new cases fail (`coding` unknown / no throw).

**Step 3 — Implement in `config.ts`.** Add the `CodingSetting`, extend `DeskmateConfig`, add `github` to `TeamConfig`, and add validation in `defineTeam`:

```ts
// near MemorySetting
const CodingSetting = z.object({
  repos: z.array(z.string()).default([]), // glob allowlist, e.g. "acme/*"; must be within github.org
});

// in DeskmateConfig, after `memory`:
coding: z.union([z.boolean(), CodingSetting]).optional().transform((c) => {
  if (c === undefined || c === false) return undefined;
  return c === true ? CodingSetting.parse({}) : c;
}),

// in TeamConfig, after `connections`:
github: z.object({ org: z.string().min(1) }).optional(), // App secrets come from env, not config

export type CodingSetting = z.infer<typeof CodingSetting>;
```

In `defineTeam`, after the existing per-deskmate loop, add validation:

```ts
for (const [id, d] of Object.entries(team.deskmates)) {
  if (!d.coding) continue;
  if (!team.github) {
    throw new Error(`deskmate "${id}" has coding enabled but the team has no \`github\` block (set github.org and the GITHUB_APP_* env).`);
  }
  for (const r of d.coding.repos) {
    const owner = r.split("/")[0];
    if (owner !== team.github.org) {
      throw new Error(`deskmate "${id}" coding.repos entry "${r}" must be within the single configured github.org "${team.github.org}".`);
    }
  }
}
```

Export `CodingSetting` type from `src/index.ts` alongside `DeskmateConfig`.

**Step 4 — Run, verify pass:** `pnpm --filter @deskmate/core test`.

**Step 5 — Commit:** `feat(core): coding opt-in + github team block in team config`

---

## Task 1: `@deskmate/core/coding` — GitHub App installation-token helper

**Files:**
- Modify: `packages/core/package.json` (add deps + `./coding` export)
- Create: `packages/core/src/coding/github-app.ts`, `packages/core/src/coding/index.ts`
- Test: `packages/core/test/coding-github-app.test.ts`

**Step 1 — Add deps.** In `packages/core/package.json` dependencies: `"@octokit/auth-app": "^7.1.0"`, `"@octokit/rest": "^21.0.0"` (pin to current majors; verify latest at implementation time). Add the subpath export:

```json
"./coding": { "types": "./dist/coding/index.d.ts", "default": "./dist/coding/index.js" }
```

Run `pnpm install`.

**Step 2 — Write failing test.** Inject an `octokit`-like factory so no network is hit:

```ts
import { describe, it, expect, vi } from "vitest";
import { getInstallationToken } from "../src/coding/github-app.js";

it("mints an installation token for an org", async () => {
  const appAuth = vi.fn().mockResolvedValue({ token: "ghs_installtoken" });
  const deps = {
    createAppAuth: () => appAuth,
    listInstallationForOrg: vi.fn().mockResolvedValue({ installationId: 42 }),
  };
  const tok = await getInstallationToken({ appId: "1", privateKey: "k", org: "acme" }, deps);
  expect(tok).toBe("ghs_installtoken");
  expect(appAuth).toHaveBeenCalledWith(expect.objectContaining({ type: "installation", installationId: 42 }));
});
```

**Step 3 — Implement `github-app.ts`** with an injected-deps seam:

```ts
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GithubAppConfig { appId: string; privateKey: string; org: string; }
export interface GithubAppDeps {
  createAppAuth: typeof createAppAuth;
  listInstallationForOrg: (cfg: GithubAppConfig) => Promise<{ installationId: number }>;
}
const defaultDeps: GithubAppDeps = {
  createAppAuth,
  async listInstallationForOrg({ appId, privateKey, org }) {
    const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const { data } = await appOctokit.apps.getOrgInstallation({ org });
    return { installationId: data.id };
  },
};
export async function getInstallationToken(cfg: GithubAppConfig, deps: GithubAppDeps = defaultDeps): Promise<string> {
  const { installationId } = await deps.listInstallationForOrg(cfg);
  const auth = deps.createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
  const { token } = await auth({ type: "installation", installationId });
  return token;
}
export function readGithubAppEnv(): GithubAppConfig & { present: boolean } {
  return {
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKey: (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    org: process.env.GITHUB_APP_ORG ?? "",
    present: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
  };
}
```

Barrel `src/coding/index.ts`: `export { getInstallationToken, readGithubAppEnv, type GithubAppConfig } from "./github-app.js";`

**Step 4 — Run, verify pass:** `pnpm --filter @deskmate/core test` + `pnpm --filter @deskmate/core typecheck`.

**Step 5 — Commit:** `feat(core): coding/github-app installation-token helper`

---

## Task 2: `@deskmate/core/coding` — the coding sandbox factory

**Files:**
- Create: `packages/core/src/coding/sandbox.ts`
- Modify: `packages/core/src/coding/index.ts`
- Test: `packages/core/test/coding-sandbox.test.ts`

**Step 1 — Write failing test.** The factory returns a `defineSandbox` definition; drive its `onSession` with a fake `use` and assert the brokered policy:

```ts
import { createCodingSandbox } from "../src/coding/sandbox.js";

it("onSession locks egress and brokers the github.com token", async () => {
  const captured: any[] = [];
  const def = createCodingSandbox({ org: "acme", repos: ["acme/*"], getToken: async () => "ghs_x" });
  await def.onSession!({ use: async (o: any) => { captured.push(o); return {} as any; }, ctx: {} as any });
  const pol = captured[0].networkPolicy;
  expect(pol.allow["github.com"][0].transform[0].headers.authorization).toContain("ghs_x");
  expect(pol.allow["*"]).toBeUndefined(); // deny-by-default except explicit allows (or assert catch-all per final shape)
  expect(Object.keys(pol.allow)).toContain("github.com");
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement `sandbox.ts`:**

```ts
import { defineSandbox, defaultBackend } from "eve/sandbox";
import { getInstallationToken, readGithubAppEnv } from "./github-app.js";

export interface CodingSandboxOptions {
  org: string;
  repos: string[];
  /** Test seam; defaults to minting via the App env. */
  getToken?: () => Promise<string>;
}
const ALLOW_HOSTS = ["github.com", "codeload.github.com", "objects.githubusercontent.com",
  "registry.npmjs.org", "ai-gateway.vercel.sh"]; // extend per ecosystem as needed

export function createCodingSandbox(opts: CodingSandboxOptions) {
  const getToken = opts.getToken ?? (async () => {
    const env = readGithubAppEnv();
    return getInstallationToken({ appId: env.appId, privateKey: env.privateKey, org: opts.org });
  });
  return defineSandbox({
    backend: defaultBackend({ vercel: { resources: { vcpus: 2 } }, docker: { image: "ghcr.io/vercel/eve:latest" } }),
    async onSession({ use }) {
      const token = await getToken();
      const allow: Record<string, unknown> = {};
      for (const h of ALLOW_HOSTS) allow[h] = [];
      allow["github.com"] = [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }];
      allow["codeload.github.com"] = [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }];
      await use({ networkPolicy: { allow } as any });
    },
  });
}
```

> **Verify at implementation time** against `sandbox.mdx:188-225`: (a) the exact `networkPolicy.allow` object-vs-array shape and whether a `"*": []` catch-all is needed to keep npm/etc. reachable, and (b) that `Bearer <install-token>` (vs the `x-access-token:<token>` Basic form) is what git-over-HTTPS accepts through the broker. Adjust `ALLOW_HOSTS`/scheme to what the docs + a `docker`-backed smoke test confirm.

Add to barrel: `export { createCodingSandbox, type CodingSandboxOptions } from "./sandbox.js";`

**Step 4 — Run, verify pass** (+ typecheck).

**Step 5 — Commit:** `feat(core): coding sandbox factory with firewall-brokered github token`

---

## Task 3: `@deskmate/core/coding` — the approval-gated `open_pull_request` tool

**Files:**
- Create: `packages/core/src/coding/open-pull-request.ts`
- Modify: `packages/core/src/coding/index.ts`
- Test: `packages/core/test/coding-open-pull-request.test.ts`

**Step 1 — Write failing tests** against the pure helper `submitPullRequest(input, deps)`:

```ts
import { submitPullRequest } from "../src/coding/open-pull-request.js";

const base = { repo: "acme/api", branch: "deskmate/engineer/fix-typo", base: "main",
  title: "Fix typo", body: "…", commitMessage: "fix: typo", allowlist: ["acme/*"] };
const okDeps = {
  runGit: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  openPr: vi.fn().mockResolvedValue({ html_url: "https://github.com/acme/api/pull/7" }),
};

it("refuses to push to the default/base branch", async () => {
  await expect(submitPullRequest({ ...base, branch: "main" }, okDeps)).rejects.toThrow(/default branch/i);
  expect(okDeps.runGit).not.toHaveBeenCalled();
});
it("refuses a repo outside the allowlist", async () => {
  await expect(submitPullRequest({ ...base, repo: "evil/x" }, okDeps)).rejects.toThrow(/allowlist/i);
});
it("pushes the feature branch and opens a PR", async () => {
  const res = await submitPullRequest(base, okDeps);
  expect(okDeps.runGit).toHaveBeenCalledWith(expect.stringContaining("push"));
  expect(okDeps.openPr).toHaveBeenCalledWith(expect.objectContaining({ repo: "acme/api", head: base.branch, base: "main" }));
  expect(res.url).toBe("https://github.com/acme/api/pull/7");
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement `open-pull-request.ts`:** pure helper + `defineTool` wrapper.

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { minimatch } from "minimatch"; // or a tiny glob check; verify a matcher dep is acceptable

export interface SubmitInput {
  repo: string; branch: string; base: string; title: string; body: string;
  commitMessage: string; allowlist: string[];
}
export interface SubmitDeps {
  runGit: (command: string) => Promise<{ stdout: string; stderr: string }>;
  openPr: (a: { repo: string; head: string; base: string; title: string; body: string }) => Promise<{ html_url: string }>;
}
export async function submitPullRequest(input: SubmitInput, deps: SubmitDeps): Promise<{ url: string }> {
  if (input.branch === input.base) throw new Error("refusing to push to the default branch — open a feature branch");
  const allowed = input.allowlist.some((g) => minimatch(input.repo, g));
  if (!allowed) throw new Error(`repo "${input.repo}" is not in the coding allowlist`);
  await deps.runGit(`git push origin ${input.branch}`);
  const pr = await deps.openPr({ repo: input.repo, head: input.branch, base: input.base, title: input.title, body: input.body });
  return { url: pr.html_url };
}

export function createOpenPullRequestTool(opts: { deskmateId: string; org: string; repos: string[] }) {
  return defineTool({
    description:
      "Push the current feature branch and open a pull request for human review. NEVER targets the default branch; NEVER merges. Requires approval.",
    inputSchema: z.object({
      repo: z.string().describe('"owner/name" of the repo cloned into the sandbox'),
      branch: z.string().describe("the feature branch you created, e.g. deskmate/engineer/<slug>"),
      base: z.string().default("main"),
      title: z.string(), body: z.string(), commitMessage: z.string(),
    }),
    approval: always(),
    async execute(input, ctx) {
      const sandbox = await ctx.getSandbox();
      const deps: SubmitDeps = {
        runGit: (command) => sandbox.run({ command }),
        openPr: async (a) => {
          const env = readGithubAppEnv();
          const token = await getInstallationToken({ appId: env.appId, privateKey: env.privateKey, org: opts.org });
          const octokit = new Octokit({ auth: token });
          const [owner, name] = a.repo.split("/");
          const { data } = await octokit.pulls.create({ owner, repo: name, head: a.head, base: a.base, title: a.title, body: a.body });
          return { html_url: data.html_url };
        },
      };
      return submitPullRequest({ ...input, allowlist: opts.repos.length ? opts.repos : [`${opts.org}/*`] }, deps);
    },
  });
}
```

> Confirm a glob matcher is available/acceptable (`minimatch` is tiny and ubiquitous) or inline a `owner === org` + name check. Confirm `ctx.getSandbox()` + `sandbox.run` return shape against `sandbox.mdx`.

Barrel: `export { createOpenPullRequestTool, submitPullRequest } from "./open-pull-request.js";`

**Step 4 — Run, verify pass** (+ typecheck).

**Step 5 — Commit:** `feat(core): approval-gated open_pull_request coding tool`

---

## Task 4: coding safety-rules instruction block

**Files:**
- Create: `packages/core/src/coding/instructions.ts`, `packages/core/src/coding/instructions.md`
- Modify: `packages/core/src/coding/index.ts`, `packages/core/package.json` build copy step (it already copies `*.md` — extend the copy list to include `coding/instructions.md`)
- Test: `packages/core/test/coding-instructions.test.ts`

**Step 1 — Write failing test:** `createCodingInstructions()` returns markdown containing the hard rules.

```ts
import { createCodingInstructions } from "../src/coding/instructions.js";
it("states the coding hard rules", () => {
  const md = createCodingInstructions();
  expect(md).toMatch(/never.*default branch/i);
  expect(md).toMatch(/never merge/i);
  expect(md).toMatch(/open_pull_request/);
  expect(md).toMatch(/deskmate\/<id>\/<slug>|feature branch/i);
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement.** `instructions.md` holds the rules (clone → reproduce → branch `deskmate/<id>/<slug>` → smallest diff → run tests → `open_pull_request` → post link; never default branch, never merge, never raw `git push`, stay in allowlist). `instructions.ts`:

```ts
import instructions from "./instructions.md"; // if the build inlines md; else read via a generated .ts (mirror house-style.ts)
export function createCodingInstructions(): string { return instructions; }
```

> Match how `house-style.ts` loads `house-style.md` (the exploration noted the build copies these `.md` into `dist` and a lazy `require`/import reads them). Reuse that exact mechanism so it works after `tsc` build.

**Step 4 — Run, verify pass.**

**Step 5 — Commit:** `feat(core): coding safety-rules instruction block`

---

## Task 5: CLI render functions for the coding slots

**Files:**
- Modify: `packages/cli/src/sync/render.ts`
- Test: `packages/cli/test/render.test.ts`

**Step 1 — Write failing tests:**

```ts
import { renderCodingSandbox, renderCodingTool, renderCodingInstructions } from "../src/sync/render.js";
it("renders a sandbox shim binding the deskmate's org+repos", () => {
  const s = renderCodingSandbox("engineer", { org: "acme", repos: ["acme/*"] });
  expect(s).toContain('from "@deskmate/core/coding"');
  expect(s).toContain("createCodingSandbox");
  expect(s).toContain('"acme"');
});
it("renders the open_pull_request tool shim", () => {
  const t = renderCodingTool("engineer", { org: "acme", repos: ["acme/*"] });
  expect(t).toContain("createOpenPullRequestTool");
  expect(t).toContain("export default");
});
it("renders the coding instructions module", () => {
  expect(renderCodingInstructions("engineer")).toContain("createCodingInstructions");
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement** three renderers in `render.ts` (mirroring `renderMemoryTool`/`renderMemoryInstructions` at `:203`/`:219`), each returning `BANNER + code`:

```ts
export function renderCodingSandbox(id: string, coding: { org: string; repos: string[] }): string {
  return `${BANNER}import { createCodingSandbox } from "@deskmate/core/coding";
export default createCodingSandbox(${JSON.stringify({ org: coding.org, repos: coding.repos })});
`;
}
export function renderCodingTool(id: string, coding: { org: string; repos: string[] }): string {
  return `${BANNER}import { createOpenPullRequestTool } from "@deskmate/core/coding";
export default createOpenPullRequestTool(${JSON.stringify({ deskmateId: id, org: coding.org, repos: coding.repos })});
`;
}
export function renderCodingInstructions(id: string): string {
  return `${BANNER}import { createCodingInstructions } from "@deskmate/core/coding";
export default { instructions: createCodingInstructions() };
`;
}
```

> Confirm the exact instructions-module shape eve expects under `agent/subagents/<id>/instructions/*.ts` by matching `renderMemoryInstructions` output (the memory shim is the proven precedent).

**Step 4 — Run, verify pass:** `pnpm --filter @deskmate/cli test`.

**Step 5 — Commit:** `feat(cli): render functions for coding sandbox/tool/instructions`

---

## Task 6: Wire the coding capability into `plan.ts`

**Files:**
- Modify: `packages/cli/src/sync/plan.ts` (imports + the per-deskmate loop)
- Test: `packages/cli/test/plan.test.ts`

**Step 1 — Write failing tests** (mirror the memory-slot plan tests):

```ts
it("emits sandbox + open_pull_request + coding instructions for a coding deskmate", () => {
  const team = defineTeam({ github: { org: "acme" },
    deskmates: { engineer: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: { repos: ["acme/*"] } } } });
  const { writes } = planSync(team, "/cwd");
  const rels = writes.map((w) => w.path.replace("/cwd/", ""));
  expect(rels).toContain("agent/subagents/engineer/sandbox.ts");
  expect(rels).toContain("agent/subagents/engineer/tools/open_pull_request.ts");
  expect(rels).toContain("agent/subagents/engineer/instructions/coding.ts");
});
it("emits none of the coding slots for a non-coding deskmate", () => {
  const team = defineTeam({ deskmates: { a: { role: "r", emoji: ":x:", displayName: "A", summary: "s" } } });
  const rels = planSync(team, "/cwd").writes.map((w) => w.path);
  expect(rels.some((p) => p.endsWith("/sandbox.ts"))).toBe(false);
  expect(rels.some((p) => p.endsWith("/tools/open_pull_request.ts"))).toBe(false);
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement.** Import the three renderers in `plan.ts`; inside the per-deskmate loop, after the memory block (`:182`), add:

```ts
if (d.coding && team.github) {
  const coding = { org: team.github.org, repos: d.coding.repos };
  out(`agent/subagents/${id}/sandbox.ts`, renderCodingSandbox(id, coding));
  out(`agent/subagents/${id}/tools/open_pull_request.ts`, renderCodingTool(id, coding));
  out(`agent/subagents/${id}/instructions/coding.ts`, renderCodingInstructions(id));
}
```

(No delete-handling needed: `sync/index.ts` wipes each `agent/subagents/<id>/` before writing, so turning `coding` off simply stops emitting the slots.)

**Step 4 — Run, verify pass** (+ idempotency test still green).

**Step 5 — Commit:** `feat(cli): sync emits the coding capability for coding-enabled deskmates`

---

## Task 7: `.env.example` — GitHub App keys

**Files:**
- Modify: `packages/cli/src/sync/render.ts` (`renderEnvExample`, `:310`)
- Test: `packages/cli/test/render.test.ts`

**Step 1 — Write failing test:**

```ts
it("includes GITHUB_APP_* only when a deskmate has coding", () => {
  const withCoding = defineTeam({ github: { org: "acme" },
    deskmates: { e: { role: "engineer", emoji: ":x:", displayName: "E", summary: "s", coding: true } } });
  const s = renderEnvExample(withCoding);
  expect(s).toContain("GITHUB_APP_ID"); expect(s).toContain("GITHUB_APP_PRIVATE_KEY");
  expect(s).toContain("GITHUB_APP_ORG"); expect(s).toContain("GITHUB_TOKEN"); // local fallback, commented
  const none = defineTeam({ deskmates: { a: { role: "r", emoji: ":x:", displayName: "A", summary: "s" } } });
  expect(renderEnvExample(none)).not.toContain("GITHUB_APP_ID");
});
```

**Step 2 — Run, verify fail.**

**Step 3 — Implement:** in `renderEnvExample`, add `const anyCoding = Object.values(team.deskmates).some((d) => d.coding);` and append a gated section (mirror the `anyMemory` block at `:344-352`) with `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (note the `\n`-escaping), `GITHUB_APP_ORG`, `GITHUB_WEBHOOK_SECRET` (for Phase 2), and a commented `# GITHUB_TOKEN=` local-only fallback with a "not for production" note.

**Step 4 — Run, verify pass.**

**Step 5 — Commit:** `feat(cli): scaffold GITHUB_APP_* env for coding deskmates`

---

## Task 8: The `engineer` catalog role

**Files:**
- Create: `packages/catalog/roles/engineer/deskmate.json`, `agent.ts`, `instructions.md`, `skills/agentic-coding/SKILL.md`
- Modify: whatever catalog index/manifest lists roles (grep `packages/catalog` for the roster of ids — e.g. a `roles.ts`/`index.ts` or it's discovered by directory). Update `examples/starter/deskmate.config.ts` to show a commented engineer entry + `github: { org }`.
- Test: `packages/catalog/test/` — add a shape test asserting `engineer/deskmate.json` parses and has the expected id/displayName.

**Step 1 — Write failing test** (catalog role-shape test, modeled on existing catalog tests): assert `engineer` is discoverable with `id: "engineer"`, `displayName: "Software Engineer"`, and that `agent.ts` default-exports a defineAgent with a description mentioning "pull request".

**Step 2 — Run, verify fail.**

**Step 3 — Author the files** exactly as specified in the design doc §1 (deskmate.json, agent.ts, instructions.md). Write `skills/agentic-coding/SKILL.md` (the flagship playbook: scope → reproduce → minimal diff → match style → run tests → clear PR body → flag risk). Add engineer to the catalog roster listing if one exists. In `examples/starter/deskmate.config.ts` add (commented, so the example still builds without a GitHub App):

```ts
// github: { org: "your-org" },
// engineer: { role: "engineer", emoji: ":technologist:", displayName: "Software Engineer",
//   summary: "Clones a repo, makes a scoped change on a branch, and opens a PR — never pushes to default, never merges.",
//   reads: [], coding: { repos: ["your-org/*"] } },
```

**Step 4 — Run, verify pass:** catalog tests + `deskmate add engineer` dry check if a CLI test covers `add`.

**Step 5 — Commit:** `feat(catalog): engineer (Software Engineer) coding deskmate role`

---

## Task 9: `deskmate doctor` — coding readiness check

**Files:**
- Modify: `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Step 1 — Write failing tests** (injected deps, offline): for a team with a coding deskmate, doctor (a) errors when `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` are absent, (b) errors when the private key doesn't parse, (c) warns when the resolved sandbox backend won't be firewall-capable (local/no-Vercel) so push won't work, (d) passes when env is present and (mocked) `getInstallationToken` succeeds. Follow the existing `DoctorDeps` injection style.

**Step 2 — Run, verify fail.**

**Step 3 — Implement:** add a `checkCoding(team, deps)` step that iterates coding deskmates, validates `readGithubAppEnv().present`, attempts a mocked/real `getInstallationToken` for `team.github.org`, and reports per the doctor report/exit-code conventions (hard-fail on missing/invalid App; warn on non-firewall backend).

**Step 4 — Run, verify pass.**

**Step 5 — Commit:** `feat(cli): doctor validates coding (GitHub App) readiness`

---

## Task 10: Docs — README

**Files:** Modify `README.md` (and any `packages/cli/README.md`).

Add a "Give a deskmate coding ability" section: (1) create + install a GitHub App on the org, grant `contents:write` + `pull_requests:write`, download the private key; (2) set `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ORG` (`vercel env add … --value`, per the documented stdin trap); (3) add `github: { org }` + `coding: { repos: ["org/*"] }`; (4) `deskmate sync` → `deskmate doctor` → `deskmate deploy`. Document: **Vercel backend required for push** (local Docker can't broker; `GITHUB_TOKEN` is a local-only read/explore fallback), **branch protection on the default branch is required setup**, and the safety contract (branch-per-task, PR-only, human-approved push, never merges).

**Commit:** `docs: give a deskmate coding ability (GitHub App + safety contract)`

---

## Task 11 (Phase 2): the GitHub channel

**Files:**
- Modify: `packages/cli/src/sync/{plan.ts,render.ts}` (emit a root `agent/channels/github.ts` when `team.github` + a channel opt-in is set), `packages/core/src/config.ts` (a `github.channel?: boolean` or channel-route flag), `.env.example` (`GITHUB_WEBHOOK_SECRET`).
- Test: `plan.test.ts` (emits/omits the channel), a render test for the channel shim.

**Step 1 — Write failing test:** with `github: { org, channel: true }`, `planSync` emits `agent/channels/github.ts` importing `githubChannel` from `eve/channels/github`; without it, no such file.

**Step 2 — Run, verify fail.**

**Step 3 — Implement:** `renderGithubChannel()` returns a shim configuring `githubChannel({...})` (App id/key/webhook from env). Wire an `out("agent/channels/github.ts", …)` in the root-files section gated on the opt-in. The channel's auto-checkout + `ctx.github` handle the repo; reuse `open_pull_request` semantics (or the channel's native commit/push) for writes. Verify `eve/channels/github` config shape against `channels/github.mdx` at implementation time.

**Step 4 — Run, verify pass.**

**Step 5 — Commit:** `feat: phase-2 GitHub channel for issue/PR mentions`

---

## Verification before "done"

Per @superpowers-extended-cc:verification-before-completion, before declaring the feature complete:
- `pnpm -r test` green across core/cli/catalog.
- `pnpm -r typecheck` clean (NodeNext `.js` specifiers, no missing exports).
- In `examples/starter`: uncomment the engineer entry + set a real `github.org`, run `deskmate sync`, and confirm the generated `agent/subagents/engineer/{sandbox.ts,tools/open_pull_request.ts,instructions/coding.ts}` exist and `agent/subagents/engineer/skills/agentic-coding/SKILL.md` copied.
- `deskmate doctor` reports coding readiness correctly with and without the App env.
- **End-to-end smoke (manual, requires a real App + Vercel):** deploy, ask the engineer in Slack to make a trivial change in an allowlisted repo, approve the push, confirm a PR opens against a feature branch and nothing merges. (Local Docker cannot broker the token — expect read/explore only locally.)

## Out of scope (from the design)

Auto-merge or any un-gated write; multi-org allowlists; per-user OAuth commit attribution; CI-result reading / auto-fixing checks; non-GitHub providers; any change to eve itself.
