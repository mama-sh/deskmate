# Coding-deploy sandbox provisioning — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** `deskmate deploy` provisions a coding deskmate's Vercel Sandbox templates so it doesn't crash at runtime with `SandboxTemplateNotProvisionedError`.

**Architecture:** When (and only when) the team has a `coding` deskmate, `deploy()` inserts a provisioning phase after `sync`: a **source** `vercel deploy` (no `--prebuilt`, no `--prod`) that builds on Vercel — where eve prewarms the team-scoped sandbox templates — before the existing local-build + `--prebuilt --prod` ship. Plus a post-deploy GitHub-App reminder, and an upstream eve issue for the root trace gap. Everything routes through the existing injected `DeployDeps` so it unit-tests offline.

**Tech Stack:** TypeScript (ESM), vitest, the Vercel CLI (`vercel pull`/`build`/`deploy`), `@deskmate/core` (`loadTeam` → `TeamConfig`), `gh` CLI.

**Reference:** the design doc `docs/plans/2026-07-06-coding-deploy-sandbox-provisioning-design.md` and the handoff `docs/plans/2026-07-06-coding-deploy-sandbox-provisioning-handoff.md`.

**Skills:** @superpowers-extended-cc:test-driven-development per task; @superpowers-extended-cc:verification-before-completion before each commit.

## Facts the implementer needs

- `deploy()` lives in `packages/cli/src/deploy.ts`. Today: `pull → sync → vercel build --prod (local, xfw) → patch → vercel deploy --prebuilt --prod`. Every side effect is on `DeployDeps` (`sync`, `run`, `patch`); `run(cmd, args, cwd, env?)` resolves the exit code.
- `deploy.test.ts` uses a `makeDeps(runCodes)` helper returning `{ deps, calls }`. `calls` is an ordered `string[]`: `run` pushes `run:<cmd> <args>[ xfw]` (the `[xfw]` suffix when `VERCEL_USE_EXPERIMENTAL_FRAMEWORKS` is set), `sync` pushes `"sync"`, `patch` pushes `"patch"`. Tests assert `calls` equals an exact ordered array. `run` returns queued codes in order.
- Coding detection: `Object.values(team.deskmates).some((d) => d.coding)`. `loadTeam(cwd)` (`packages/cli/src/lib/load-config.ts`) returns the parsed `TeamConfig`; `doctor.ts` already injects it as a dep.
- The provisioning deploy must be **source** (Vercel builds it → prewarm runs): `run("vercel", ["deploy", ...args], cwd, { VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1" })` — NO `--prebuilt`, NO `--prod`.

---

## Task 1: `deploy()` provisioning phase (gated on a coding deskmate)

**Files:**
- Modify: `packages/cli/src/deploy.ts`
- Test: `packages/cli/test/deploy.test.ts`

**Step 1 — extend the test helper + write failing tests.** In `deploy.test.ts`, add `loadTeam` to `makeDeps` (default: a non-coding team; a `{ coding: true }` option returns a team with a coding deskmate). `loadTeam` does NOT push to `calls` (it's a read, so existing `calls` assertions are unaffected):

```ts
import type { TeamConfig } from "@deskmate/core";

function makeDeps(runCodes: number[] = [0, 0], opts: { coding?: boolean } = {}) {
  const calls: string[] = [];
  const queue = [...runCodes];
  const team = {
    deskmates: opts.coding ? { engineer: { coding: { repos: [] } } } : { devops: {} },
  } as unknown as TeamConfig;
  const deps: DeployDeps = {
    loadTeam: vi.fn(async () => team),
    sync: vi.fn(async () => { calls.push("sync"); }),
    run: vi.fn(async (cmd, args, _cwd, env) => {
      const envNote = env?.VERCEL_USE_EXPERIMENTAL_FRAMEWORKS ? " [xfw]" : "";
      calls.push(`run:${cmd} ${args.join(" ")}${envNote}`);
      return queue.shift() ?? 0;
    }),
    patch: vi.fn(() => { calls.push("patch"); return ["/out/__server.func"]; }),
  };
  return { deps, calls };
}
```

Add these tests (the existing 3 tests keep passing unchanged — they use the non-coding default, proving a normal deploy is untouched):

```ts
it("coding team: provisions via a SOURCE vercel deploy after sync, before the local build", async () => {
  const { deps, calls } = makeDeps([0, 0, 0, 0], { coding: true }); // pull, provision, build, deploy
  const code = await deploy(["--yes"], "/proj", deps);
  expect(code).toBe(0);
  expect(calls).toEqual([
    "run:vercel pull --yes --environment=production --yes [xfw]",
    "sync",
    "run:vercel deploy --yes [xfw]", // SOURCE provisioning: no --prebuilt, no --prod
    "run:vercel build --prod --yes [xfw]",
    "patch",
    "run:vercel deploy --prebuilt --prod --yes",
  ]);
});

it("coding team: a failed provisioning deploy short-circuits (no build, no patch, no prebuilt deploy)", async () => {
  const { deps, calls } = makeDeps([0, 5], { coding: true }); // pull ok, provision exits 5
  const code = await deploy([], "/proj", deps);
  expect(code).toBe(5);
  expect(calls).toEqual([
    "run:vercel pull --yes --environment=production [xfw]",
    "sync",
    "run:vercel deploy [xfw]",
  ]);
  expect(deps.patch).not.toHaveBeenCalled();
});
```

**Step 2 — run, verify fail:** `pnpm --filter @deskmate/cli exec vitest run test/deploy.test.ts` → the two new tests fail (no provisioning phase yet); the existing 3 still pass.

**Step 3 — implement in `deploy.ts`.** Add `loadTeam` to `DeployDeps` + `defaultDeps`, and insert the provisioning phase after `sync`:

```ts
import { loadTeam } from "./lib/load-config.js";
import type { TeamConfig } from "@deskmate/core";

export interface DeployDeps {
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  run: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
  patch: (cwd: string) => string[];
}

const defaultDeps: DeployDeps = { loadTeam, sync: syncCommand, run: runCommand, patch: patchVercelEveTrace };
```

In `deploy()`, after `await deps.sync(cwd);` and before the local `vercel build`:

```ts
  // eve provisions ("prewarms") each coding deskmate's Vercel Sandbox template only during a
  // build that runs ON Vercel (it gates on VERCEL_DEPLOYMENT_ID). Our local `vercel build` +
  // --prebuilt upload therefore references templates that were never created → the deskmate
  // throws SandboxTemplateNotProvisionedError on its first coding turn. So for a coding team,
  // first run a SOURCE `vercel deploy` (no --prebuilt) — Vercel builds it, eve prewarms the
  // team-scoped templates — then the prebuilt prod deploy below resolves them by content hash.
  const team = await deps.loadTeam(cwd);
  const hasCoding = Object.values(team.deskmates).some((d) => d.coding);
  if (hasCoding) {
    const provisionCode = await deps.run("vercel", ["deploy", ...args], cwd, {
      VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
    });
    if (provisionCode !== 0) return provisionCode; // build failed — don't ship an unprovisioned coding bot
    console.log(
      "✓ provisioned coding sandbox templates via a source build " +
        "(the preview 500s harmlessly and is unaliased — `vercel remove` it if you like).",
    );
  }
```

**Step 4 — run, verify pass:** `pnpm --filter @deskmate/cli exec vitest run test/deploy.test.ts` (all pass) + `pnpm --filter @deskmate/cli typecheck`.

**Step 5 — commit:**
```bash
git add packages/cli/src/deploy.ts packages/cli/test/deploy.test.ts
git commit -m "feat(cli): deploy provisions coding sandbox templates (source build) before --prebuilt"
```

---

## Task 2: post-deploy GitHub-App reminder

**Files:**
- Modify: `packages/cli/src/deploy.ts`
- Test: `packages/cli/test/deploy.test.ts`

**Step 1 — failing test:**

```ts
it("coding team: prints the GitHub App env reminder after a successful deploy", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
  const { deps } = makeDeps([0, 0, 0, 0], { coding: true });
  await deploy([], "/proj", deps);
  spy.mockRestore();
  expect(logs.join("\n")).toMatch(/GITHUB_APP_ID/);
});

it("non-coding team: does NOT print the GitHub App reminder", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });
  const { deps } = makeDeps([0, 0, 0]);
  await deploy([], "/proj", deps);
  spy.mockRestore();
  expect(logs.join("\n")).not.toMatch(/GITHUB_APP_ID/);
});
```

**Step 2 — run, verify fail.**

**Step 3 — implement.** At the end of `deploy()`, capture the prebuilt deploy's code and, on success for a coding team, print the reminder before returning:

```ts
  const deployCode = await deps.run("vercel", ["deploy", "--prebuilt", "--prod", ...args], cwd);
  if (deployCode === 0 && hasCoding) {
    console.log(
      "\nℹ coding deskmate deployed. Set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_ORG " +
        "in the deploy env, or the clone/PR steps stay unauthenticated. Verify readiness with `deskmate doctor`.",
    );
  }
  return deployCode;
```

(`hasCoding` is already in scope from Task 1.)

**Step 4 — run, verify pass** (+ typecheck; full cli suite: `pnpm --filter @deskmate/cli test`).

**Step 5 — commit:**
```bash
git add packages/cli/src/deploy.ts packages/cli/test/deploy.test.ts
git commit -m "feat(cli): remind about GITHUB_APP_* env after a coding deploy"
```

---

## Task 3: file the eve trace-gap issue (Option C) — upstream

**Not a code task.** Draft a GitHub issue for `vercel/eve`, show it to David, and post only on approval (outward-facing, third-party repo).

**Step 1 — draft** the issue body to `docs/plans/eve-trace-gap-issue.md` (scratch, not committed): title *"Package `exports` / nitro tracing drops internal `#channel/*` subpaths → eve-on-Vercel source deploys 500 (FUNCTION_INVOCATION_FAILED)"*; body covering the symptom (`ERR_MODULE_NOT_FOUND` for `#channel/compiled-channel` on a source `vercel deploy`), the impact (forces every eve-on-Vercel user onto `--prebuilt` + a hand-maintained trace patch, and blocks coding-sandbox prewarm which only runs on an on-Vercel build), and the ask. Quote the evidence from the handoff (`vercel-build-prewarm.js` gate, the source-deploy `FUNCTION_INVOCATION_FAILED`). Note the repro is from the handoff, not re-run here.

**Step 2 — show David the draft and ask to post.**

**Step 3 — on approval, post:**
```bash
gh issue create --repo vercel/eve --title "<title>" --body-file docs/plans/eve-trace-gap-issue.md
```
Record the issue URL in the design doc's Decisions §4. If David declines, leave the draft and note it.

---

## Verification (before "done")

Per @superpowers-extended-cc:verification-before-completion:
- `pnpm -r test` green (core/cli/catalog/starter); `pnpm -r typecheck` clean.
- Re-read the `deploy.test.ts` `calls` assertions: the coding path inserts exactly one source `vercel deploy` between `sync` and `vercel build`; the non-coding path is byte-identical to the pre-change sequence.
- **Live acceptance gate (David, needs Vercel + a coding team, e.g. `addmein-deskmate`):** `deskmate deploy`, then invoke the coding deskmate — it must reach its sandbox with no `SandboxTemplateNotProvisionedError`. The on-Vercel prewarm + hash-parity behavior can only be confirmed on a real deploy; the unit tests cover orchestration only.

## Out of scope
- A real `doctor` "templates provisioned?" check (needs eve internals + Vercel API).
- Auto-removing the provisioning preview deployment.
- Options B/C's actual eve code changes; the eve `web_search` arg-parse bug (file separately).
