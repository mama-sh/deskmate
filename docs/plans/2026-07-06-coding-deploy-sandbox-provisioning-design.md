# Coding-deploy sandbox provisioning

**Date:** 2026-07-06
**Status:** Approved design — ready for implementation planning

## Problem

A deskmate with `coding` enabled deploys "successfully" via `deskmate deploy` but
**crashes at runtime** (`SandboxTemplateNotProvisionedError`) on its first coding turn,
because its Vercel Sandbox template was never provisioned. Root cause + full analysis in
the handoff: `docs/plans/2026-07-06-coding-deploy-sandbox-provisioning-handoff.md`.

`deskmate deploy` runs `vercel build` **locally**, and eve only prewarms (provisions)
sandbox templates during a build **running on Vercel** — it gates on `VERCEL_DEPLOYMENT_ID`,
which a local build lacks. So the `--prebuilt` upload references templates that were never
created. The prebuilt path is itself load-bearing: a plain source `vercel deploy`
reintroduces the eve `#channel` trace gap (500s on every route), which is exactly why
`deskmate deploy` uses `--prebuilt` + `patchVercelEveTrace`. Neither pure path works for a
coding deskmate.

## Key findings

1. **Templates are team-scoped, content-hashed named Vercel Sandboxes** (not
   deployment-scoped). Provisioning them once via any on-Vercel build of the same source
   makes them resolvable by a later `--prebuilt` deploy that looks them up by the same hash.
   **The handoff confirmed this empirically** — "a throwaway source *preview* build
   provisioned the templates the production prebuilt deploy needed." So Option A automates a
   manual fix that already worked, not a speculative one.
2. `deploy()` (`packages/cli/src/deploy.ts`) is `pull → sync → vercel build → patch →
   vercel deploy --prebuilt`, with every side-effect injected via `DeployDeps` — a new
   provisioning phase drops in and unit-tests like the existing `sync`/`run`/`patch` deps.
3. The coding gate is `loadTeam(cwd)` (already used by `doctor`) →
   `Object.values(team.deskmates).some((d) => d.coding)`. Only coding teams have sandboxes,
   so the fix must be conditional — non-coding deploys stay untouched.
4. A real `doctor` "templates provisioned?" check needs eve's internal
   `createRuntimeSandboxTemplateKey` (not exported) + the Vercel Sandbox API, so it is **not
   feasible** without an eve change. Out of scope; noted as a follow-up.

## Decisions

1. **Option A (automate the source-preview provisioning), gated on a coding deskmate.**
   Chosen over Option B (needs eve to export `prewarmAppSandboxes`) and Option C (fix the eve
   trace gap upstream) because it's the only one implementable in deskmate today, and Fact #1
   already confirms it works. B/C are cross-repo; C is filed upstream (below).
2. **Abort on provisioning failure.** If the source provisioning deploy exits non-zero, the
   on-Vercel build failed → return that code and do NOT ship the prebuilt prod deploy. A
   coding bot with unprovisioned sandboxes is worse than a failed deploy — turn a silent
   runtime crash into a deploy-time failure.
3. **Skip preview auto-cleanup for MVP.** The provisioning preview 500s harmlessly and is
   unaliased. Removing it needs the deploy URL (the injected `run` seam returns only an exit
   code), so MVP prints a one-line note instead of auto-removing. Auto-cleanup is a follow-up.
4. **File the eve trace-gap issue (Option C) with the handoff's documented evidence.** A live
   re-repro needs a Vercel deploy not available on this machine, so the issue cites the
   handoff's captured `FUNCTION_INVOCATION_FAILED` / prewarm-gate evidence, repro-honest.
   **Filed: https://github.com/vercel/eve/issues/556** (matched eve's `bug_report.yml`).

## Design

### 1. `deploy()` provisioning phase — `packages/cli/src/deploy.ts`

`DeployDeps` gains `loadTeam: (cwd) => Promise<TeamConfig>` (default: the real `loadTeam`).
New order:

```
vercel pull --yes --environment=production        (step 0, unchanged)
sync
── if the team has a coding deskmate: ──
  vercel deploy [...args]        (SOURCE preview: no --prebuilt, no --prod; xfw=1)
    → builds on Vercel (VERCEL_DEPLOYMENT_ID present) → prewarms team-scoped templates
    → non-zero exit ⇒ return it (abort; don't ship an unprovisioned coding bot)
    → print: "provisioned sandbox templates via a source preview build (harmless 500s;
              remove with `vercel remove` if you like)"
────────────────────────────────────────
vercel build --prod            (local; xfw=1)      (unchanged)
patch eve trace                                    (unchanged)
vercel deploy --prebuilt --prod                    (unchanged)
── if coding: print the post-deploy reminder (§2) ──
```

Only the coding branch is new; a non-coding deploy is byte-identical to today (the
`loadTeam` call is the only added work, and it's cheap). Detection:
`const hasCoding = Object.values((await deps.loadTeam(cwd)).deskmates).some((d) => d.coding)`.

### 2. Post-deploy coding reminder — `deploy.ts`

After the prebuilt prod deploy returns 0 for a coding team, print a visible reminder:
sandbox templates were provisioned above, and `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` /
`GITHUB_APP_ORG` must be set in the deploy env or the clone/PR steps stay unauthenticated.
Tribal knowledge → one line on screen. (Skipped for non-coding teams.)

### 3. eve trace-gap issue — `vercel/eve`

`gh issue create --repo vercel/eve` with: the symptom (source `vercel deploy` 500s /
`ERR_MODULE_NOT_FOUND` on an eve `#channel/compiled-channel` import), the impact (forces
every eve-on-Vercel user onto `--prebuilt` + a hand-maintained trace patch, and blocks
coding-sandbox provisioning), and the ask (make eve's package `exports` / nitro tracing
follow the internal `#channel/*` subpaths). Evidence quoted from the handoff. **Draft shown
for approval before posting.**

## Testing

`packages/cli/test/deploy.test.ts` (injected deps, offline — extends the existing suite):

- **Coding team**: the provisioning `vercel deploy` (source: args include neither
  `--prebuilt` nor `--prod`) runs after `sync` and before `vercel build`; assert command
  order via the existing `calls[]` recorder.
- **Non-coding team**: no provisioning deploy — the call sequence equals today's
  (pull → build → deploy --prebuilt), so a normal deploy is provably unchanged.
- **Provisioning failure**: a non-zero source deploy short-circuits — no `build`, no
  `patch`, no prebuilt deploy; `deploy()` returns that code.
- **Reminder**: the coding reminder is logged only for a coding team (spy `console`).

The `loadTeam` dep is stubbed per test (coding vs non-coding team object), mirroring how
`doctor.test.ts` stubs `loadTeam`.

**Acceptance gate (live, by David):** `deskmate deploy` a coding team (`addmein-deskmate`),
then invoke it — it must reach its sandbox without `SandboxTemplateNotProvisionedError`.
The real on-Vercel prewarm + hash-parity behavior can only be verified on a live deploy;
the unit tests cover the orchestration, not Vercel's behavior.

## Out of scope

- A real `doctor` "templates provisioned?" check (needs eve internals + Vercel API — an eve
  change first).
- Option B (`prewarmAppSandboxes` export) and Option C's actual eve fix (cross-repo).
- Auto-removing the provisioning preview deployment.
- The related eve `web_search` arg-parse bug (file separately upstream).
