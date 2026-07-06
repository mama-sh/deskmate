# Agentic-coding deskmates (git clone / edit / commit / PR)

**Date:** 2026-07-05
**Status:** Approved design — ready for implementation planning

## Problem

Deskmates today are read-only coworkers: every catalog tool and MCP connection is
scoped to reads (intercom, sentry, mixpanel, …), and the strongest action any role
takes is to *propose* a change (`devops` explicitly "PROPOSES (never auto-applies)").
We want deskmates that can do **agentic coding work** — clone a GitHub repo, make a
scoped change, run tests, commit, and push — so you can hand one a bug or a small
feature the way you'd hand it to a teammate.

The question we set out to answer was "does the eve framework enable this, and if
not what are the options." **It does, natively** — no eve fork required. The real
work is packaging it safely into the deskmate model.

## Key findings

### eve already provides the whole coding substrate (v0.19.0)

- **Every agent gets an isolated sandbox** rooted at `/workspace`, with built-in
  `bash` / `read_file` / `write_file` / `glob` / `grep` tools. Authored tools get a
  live handle via `ctx.getSandbox()` → `.run({command})` (blocking), `.spawn()`
  (long-running), file I/O, `setNetworkPolicy`. So `git`, `node`, and package
  managers are just shell. (`eve/docs/sandbox.mdx`)
- **`/workspace` persists across turns** for a durable session — a cloned repo
  survives between messages (Vercel VM idles at ~30 min then resumes "even days
  later"; Docker keeps a long-lived container). (`eve/docs/sandbox.mdx`)
- **`defineSandbox`** (`agent/sandbox/sandbox.ts` + `workspace/**`) with two hooks:
  `bootstrap` (template-scoped, once — "cloning a baseline repo, installing
  dependencies") and `onSession` (per durable session — network policy, per-user
  creds from `ctx.session.auth.current`). Backends: `vercel()`, `docker()`,
  `microsandbox()`, `justbash()`, `defaultBackend()` (auto-selects
  Vercel-on-Vercel → Docker → microsandbox → just-bash).
- **Firewall credential brokering.** Secrets never enter the sandbox; the egress
  firewall injects auth headers per-domain via `networkPolicy.transform`. eve's
  own **GitHub channel** uses exactly this: "The installation token never enters
  the sandbox. `git` fetches a token-free URL, and the platform injects auth on
  egress at the firewall. That requires a firewall-capable backend (Vercel); the
  local backend skips checkout." (`eve/docs/channels/github.mdx`,
  `eve/docs/sandbox.mdx`)
- **Human-in-the-loop approval** on tools: `approval: always() / once() / never()`
  (`eve/tools/approval`) pauses a call durably until a human approves — the gate
  for anything outbound. (`eve/docs/tools/overview.mdx`, `tools/human-in-the-loop.md`)
- **The root-level GitHub channel** (`githubChannel` from `eve/channels/github`)
  is near-turnkey for the second surface: `@mention` on an issue/PR → repo
  auto-checked-out into the sandbox → edit → commit/push with brokered auth.
  Config via `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET`.

### Best practice picks the auth + workflow for us

- **Auth → GitHub App, not PAT.** Short-lived install tokens (~1 h, auto-expiring),
  fine-grained per-repo permissions, per-org rate limits + revocation; the
  documented "correct auth model for multi-tenant B2B agents." PATs are
  discouraged for production automation. The same App is *required* by eve's GitHub
  channel, so **one App powers both surfaces**. A PAT env var exists only as a
  clearly-marked local/dev escape hatch (local Docker can't do firewall brokering).
- **Workflow → branch-per-task → PR → human review.** Never commit to the default
  branch; every task gets its own `deskmate/<id>/<slug>` branch; **always open a
  PR, never auto-merge, always require human review**; co-author commits; run in a
  sandbox with least-privilege egress; **separate execution from analysis with a
  human approval gate** on the push/PR step.

### The one deskmate-specific gap

Deskmates are eve **declared subagents** with *fully isolated* sandboxes (a subagent
inherits nothing from the root; an absent slot falls back to the framework default,
not the root's). `deskmate sync` (`packages/cli/src/sync/plan.ts:112-183`,
`render.ts`) currently emits `agent.ts` / `instructions.md` / `tools/*` /
`connections/*` / `skills/**` / memory shims per subagent — **but not a `sandbox/`
slot, and no write-capable git tooling**. Closing that gap is the core of Phase 1.

## Decisions

1. **Reusable `coding` capability, opt-in per deskmate** — not an engineer-only
   bolt-on. `coding: true | { repos: [...] }` on any roster entry turns on the
   sandbox + git tools + `agentic-coding` skill + GitHub-App wiring (so `devops`
   could flip it on to *apply* a fix, not just propose). Mirrors the existing
   `memory: true | {…}` opt-in. The capability template lives in
   `@deskmate/core` / catalog, injected by `sync`; roles stay thin (persona +
   instructions + the flag).
2. **GitHub App is the auth model**, brokered at the firewall. Secrets via env
   (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` for the
   Phase-2 channel). A PAT (`GITHUB_TOKEN`) is a documented local-only fallback,
   never the production path.
3. **Reads happen in-sandbox; writes go through one approval-gated tool.** Clone /
   fetch / read use a brokered **read-scoped** token at the firewall (no gate,
   sandboxed). The **push + open-PR** step is a single `approval: always()` tool
   running in the app runtime holding a write-capable install token — the clean
   analysis/execution split. Never the default branch, never a merge.
4. **Slack-first, GitHub-channel second** (both surfaces, phased). Phase 1 is the
   `engineer` deskmate + the sync extension (the bulk). Phase 2 wires
   `githubChannel` for issue/PR mentions, reusing the same App.
5. **Vercel Sandbox is the supported backend for real coding.** Firewall brokering
   needs `vercel()` (or `microsandbox()`); local `docker()` is allow-all/deny-all
   only. Local dev of a coding deskmate falls back to the `GITHUB_TOKEN` escape
   hatch or read-only exploration. This is inherent to eve, surfaced in docs +
   `doctor`, not a choice we make.

## Design

### 1. The `engineer` role — `packages/catalog/roles/engineer/`

Modeled on `devops` (closest analog) but *allowed to act* behind the PR gate.

- **`deskmate.json`** — `id: "engineer"`, `displayName: "Software Engineer"`,
  `emoji: ":technologist:"`, `summary` = "Clones a repo into an isolated sandbox,
  makes a scoped change on a branch, runs tests, and opens a PR for review — never
  pushes to the default branch, never merges.", `skill: "…@agentic-coding"`,
  `voice` = pragmatic senior engineer, `providers: ["github"]`.
- **`agent.ts`** — `defineAgent` routing description ("Delegate here to fix a bug,
  apply a scoped feature, bump a dependency…"; NEVER default branch / NEVER
  merge), `model: "anthropic/claude-sonnet-5"` (house default; overridable — easy
  to bump for hard tasks).
- **`instructions.md`** — the safety-gated loop: understand → clone + reproduce →
  branch `deskmate/engineer/<slug>` → smallest correct diff → run the repo's
  tests/linters → conventional-commit (co-authored with the requesting human) →
  open PR via the approval tool → post the link. Hard rules: never the default
  branch, never merge, never `git push` outside the approval tool, stay within the
  allowed repos.
- **`skills/agentic-coding/SKILL.md`** — a packaged playbook (scope the request,
  reproduce first, minimal diff, match surrounding style, run tests, write a clear
  PR body, call out risk/uncertainty). Ships in the catalog like the other role
  skills.

### 2. Config surface — `packages/core/src/config.ts`

- **`DeskmateConfig` gains `coding`**:
  `z.union([z.boolean(), z.object({ repos: z.array(z.string()).default([]) })])`,
  transformed like `memory` (`true` → defaults; `false`/omitted → `undefined`).
  `coding.repos` is a per-deskmate allowlist (glob, e.g. `"your-org/*"`) —
  defense-in-depth on top of the App's own install scope.
- **`TeamConfig` gains an optional `github`** policy block (e.g. default `repos`
  allowlist, backend hint). App **secrets stay in env**, not the config file —
  consistent with the `{ kind:"mcp", env }` connection model. `defineTeam`
  validation: a deskmate with `coding` enabled requires the `github` block (or its
  env) present, analogous to the `reads` → real-connection check.
- New env keys land in the generated `.env.example` (`GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, optional `GITHUB_TOKEN`).

### 3. Sync extension — `packages/cli/src/sync/{plan.ts,render.ts}`

When a deskmate has `coding` enabled, the planner emits into
`agent/subagents/<id>/`:

- **`sandbox/sandbox.ts`** — rendered from a core template: `defineSandbox({
  backend: defaultBackend({ vercel: {...}, docker: {...} }), onSession })`. The
  `onSession` sets `networkPolicy` to `deny-all` + an allowlist (`*.github.com`,
  the package registries the repo needs, `ai-gateway.vercel.sh`) and installs the
  **read-scoped** GitHub token as a `github.com` header transform. Parameterized by
  the resolved repo allowlist.
- **`tools/open_pull_request.ts`** — re-export/shim of the core approval-gated
  tool (below).
- **`skills/agentic-coding/**`** — copied verbatim from the catalog (same path
  mapping `sync` already uses for role skills).
- House-style instruction block appends the coding hard-rules so they hold even if
  a role's `instructions.md` is terse.

This is additive to the existing slot loop; `channels/` and `schedules/` stay
root-only (unchanged). Requires confirming eve accepts
`agent/subagents/<id>/sandbox/` (docs say subagents have their own sandbox slot —
verify against the installed `eve/docs/subagents.mdx` at implementation time).

### 4. The approval-gated submit tool — `@deskmate/core` (`packages/core/src/coding/`)

`open_pull_request` (`defineTool`, `approval: always()`): inputs = branch name,
commit message, PR title/body, base branch (defaults to the repo's default;
**push target is always the feature branch**). On approval it, in the app runtime:

1. Mints a **write-capable installation token** — Phase 1 has no GitHub channel, so
   a small helper exchanges `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (JWT) → an
   installation access token scoped to the target repo. (Phase 2's channel exposes
   `ctx.github.request(...)` natively; the tool prefers it when present.)
2. Verifies the target repo is within the allowlist and the branch ≠ default.
3. Reads the working tree from the sandbox (`ctx.getSandbox()`), pushes the feature
   branch (token-injected remote for this one operation), and opens the PR via the
   GitHub REST API. Commits are co-authored (`Co-Authored-By:` the requesting human
   + the deskmate).
4. Returns the PR URL.

Keeping the write credential *out of the sandbox* and *inside the gated tool* is the
analysis/execution split; the model's in-sandbox `bash` gets only read/clone auth,
so it cannot push or merge on its own. Never merges; merge stays a human action
under branch protection.

### 5. `doctor` extension — `packages/cli/src/doctor.ts`

Add a coding-readiness check alongside the MCP connection probes: for each deskmate
with `coding` enabled, verify the App env is present, the private key parses, and
(best-effort) the App can mint an install token for the configured repos; warn if
the resolved backend won't be firewall-capable (local Docker) so push won't work.
Consistent with `doctor` being the pre-deploy / CI gate.

### 6. Phase 2 — the GitHub channel (additive)

Wire `githubChannel` at the app root (root-only, generated by `sync`). Mentions on
issues/PRs get eve's auto-checkout + the same `open_pull_request` path. Reuses the
one GitHub App (adds the webhook secret + `/eve/v1/github` route). No changes to the
Phase-1 per-deskmate machinery.

### 7. Docs — README + role docs

- "Give a deskmate coding ability" section: create + install the GitHub App, set the
  three env keys, add `coding: { repos }` to a roster entry, `deskmate sync`.
- The Vercel-backend requirement for push, and the `GITHUB_TOKEN` local-only
  fallback.
- The safety contract: branch-per-task, PR-only, human-approved push, never merges.

## Testing

- **`config.test.ts`** — `coding` parses (`true` → defaults, object → allowlist,
  omitted → undefined); `defineTeam` rejects `coding` without `github`.
- **Sync planner tests** — a `coding`-enabled deskmate emits `sandbox/sandbox.ts`,
  `tools/open_pull_request.ts`, and the `agentic-coding` skill; a plain deskmate
  emits none of them (snapshot/plan assertions, mirroring existing `plan` tests).
- **Sandbox template test** — rendered `sandbox.ts` locks egress to the allowlist
  and installs the `github.com` transform; repo allowlist threads through.
- **`open_pull_request` tests** (injected deps, offline) — refuses default-branch
  push; refuses out-of-allowlist repo; happy path pushes the feature branch + opens
  a PR + returns the URL + co-authors the commit; is `approval: always()`.
- **App-token helper test** — JWT → install-token exchange over a canned response;
  scoping/error paths.
- **`doctor.test.ts`** — coding-readiness: missing env, unparseable key,
  non-firewall backend warning, all-green.

All offline via injected deps / canned responses, consistent with the existing CLI
suite (no real network, no real GitHub).

## Out of scope

- Auto-merging PRs, or any write that bypasses the human PR gate.
- Multi-repo / mono-repo orchestration beyond a single clone per task.
- Per-user OAuth attribution (commits are co-authored; true per-teammate GitHub
  identity is a later option, noted not built).
- CI-result reading / auto-fixing failing checks on the opened PR.
- Non-GitHub providers (GitLab/Bitbucket).
- Any change to eve itself.
