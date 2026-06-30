# Design: Deploy button, onboarding, and channel routing

Date: 2026-06-30
Status: Approved (brainstorming → ready for implementation plan)
Scope: single-deployment OSS layer (option A — env tokens, one org per deploy)

## Context

Deskmate is an Eve app: a front-desk router delegates to **deskmates** (subagents)
under `agent/subagents/<id>/`, sourced from a `library/deskmates/<id>/` catalog via
`pnpm deskmate:add`. Reads run free; writes gate on `approval: always()`. This design
adds three independent features. All work within Eve's hard constraint: **connections
are compiled at build time** — a new MCP URL cannot be registered at runtime, so adding
a tool means generating a connection file and redeploying.

Decisions locked during brainstorming:
- Onboarding audience: **(a) developer self-host via CLI + runbook** (not a no-code wizard).
- Custom MCP authoring: **(i) CLI scaffold** consistent with `deskmate:add`.
- Channel routing: **default routing with an optional per-channel `lock` flag**.

## Feature A — "Deploy to Vercel" button

**Goal:** one-click bootstrap of the app to the user's own Vercel.

- README badge:
  `[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/deskmate/deskmate&project-name=deskmate&env=AI_GATEWAY_API_KEY&envDescription=...)`
- Clicking forks the repo to the user's GitHub, creates a Vercel project, and builds from
  source (Eve requires source builds, not `--prebuilt`). Model auth via project OIDC (AI
  Gateway) needs no key; `AI_GATEWAY_API_KEY` is offered as an optional prompt.
- Add **`vercel.json`** pinning `buildCommand: "eve build"` and build env
  `VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1`, so the hosted build recognizes Eve as the
  framework rather than relying on gated auto-detection. (Verify exact behaviour on first
  real deploy; this is the documented CLI flag.)
- The button does **not** configure Slack or MCPs (both need CLI). README flow:
  *button → "finish setup" runbook* (Feature B).
- **Prerequisite:** the repo must be public at `github.com/deskmate` for the button URL to
  resolve. Until then the badge links to a placeholder and the runbook covers manual deploy.

**Testing:** none automated (deploy is manual/credentialed); verified by a real deploy.

## Feature B — Onboarding (CLI wizard + custom-MCP scaffold + runbook)

Three pieces, all extending `scripts/deskmate.ts` (Node 24 native TS, no build step):

1. **`pnpm deskmate:init`** — interactive wizard:
   - Multi-select which library deskmates to activate → reuse existing `add` logic.
   - For each activated deskmate's provider(s), prompt for MCP URL + token → write/merge `.env`.
   - Print next steps (Slack connector commands, deploy). Idempotent and re-runnable.
2. **`pnpm deskmate:mcp:add <name> --to <deskmate>`** — custom MCP scaffold:
   - Prompt for URL env-var name, token env-var name, and read-tool allow-list.
   - Generate `agent/subagents/<deskmate>/connections/<name>.ts` from a read-only,
     env-token template (`tools.allow`, placeholder URL fallback).
   - Append the new env vars to `.env.example`. Remind to redeploy.
   - Pure helper `renderMcpConnection(opts)` (template string builder) is unit-tested.
3. **Runbook** in README, end-to-end:
   `deploy button → vercel link && vercel env pull → pnpm deskmate:init →
    pnpm deskmate:mcp:add (optional) → vercel connect … (Slack) → vercel deploy`.

The build-time constraint is documented: custom MCPs require a redeploy, never runtime.

**Testing:** pure connection-template builder is unit-tested; the interactive prompts are thin
I/O wrappers (kept dumb, not unit-tested).

## Feature C — Channel → deskmate routing (default + optional lock)

- **Config** `agent/lib/channel-routes.ts` (committed, hand-edited), keyed by Slack channel
  name (with channel-ID also accepted), plus a pure tested resolver:
  ```ts
  export const CHANNEL_ROUTES = {
    incidents: { deskmate: "devops", lock: true },
    growth:    { deskmate: "growth_hacker" }, // default, no lock
  };
  export function resolveRoute(channel: string, routes): { deskmate: string; lock: boolean } | null
  ```
- **Mechanism:**
  - Slack `onAppMention` resolves the channel → route and stamps it onto the session
    (auth attributes / injected context).
  - **Dynamic instructions** (`defineDynamic` on instructions, keyed on the stamped route)
    tell the front desk per turn:
    - default → "delegate to `<deskmate>` unless the user explicitly asks otherwise";
    - lock → "you may ONLY delegate to `<deskmate>` in this channel; decline other requests."
  - Unmapped channels and DMs → no extra instruction → normal front-desk routing.
- **Enforcement note:** instruction-enforced (model-level). Strong but not a hard mechanical
  wall — Eve does not cleanly hide authored subagent tools per channel. Acceptable for the
  OSS layer; documented as a limitation. A mechanical guarantee is a hosted-layer follow-up.

**Testing:** pure `resolveRoute()` logic unit-tested (mapped name, mapped id, unmapped → null,
lock vs default). Slack behaviour verified post-deploy (Slack can't be tested locally).

## Cross-cutting

- Keep the README's existing structure; add a "Deploy" badge at top and a "Finish setup"
  runbook section; document the custom-MCP and channel-routing features.
- All new pure logic is unit-tested (Vitest); `pnpm typecheck` + `pnpm build` stay green.
- Nothing here introduces multi-tenant/control-plane scope; the seams remain additive.

## Out of scope (still hosted-layer)

No-code/Slack-driven onboarding wizard, per-tenant secret vault, org dashboard, billing,
mechanical per-channel tool isolation, runtime MCP registration.
