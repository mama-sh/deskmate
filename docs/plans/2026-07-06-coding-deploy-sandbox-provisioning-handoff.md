# Handoff: `deskmate deploy` doesn't provision coding-sandbox templates

> **For a fresh conversation working in `mama-sh/deskmate`.** Self-contained. Fixes a real
> gap: a deskmate with `coding` enabled deploys "successfully" via `deskmate deploy` but
> **crashes at runtime** because its Vercel Sandbox template was never provisioned. Found
> while enabling coding on a production deployment (`addmein-deskmate`).

---

## TL;DR

`deskmate deploy` = `vercel pull` → `sync` → **`vercel build`** (local) → patch eve trace →
**`vercel deploy --prebuilt`**. eve only provisions Vercel Sandbox templates during a build
**running on Vercel** (it gates on `VERCEL_DEPLOYMENT_ID`, which a *local* `vercel build`
doesn't have). So the prebuilt path uploads an output that references sandbox templates that
were never created. A coding deskmate then throws `SandboxTemplateNotProvisionedError` on its
first turn. eve's own warning says exactly this: *"Do not deploy it with `vercel deploy
--prebuilt`; use `vercel deploy` so Vercel builds from source."* But a plain source deploy
reintroduces the eve `#channel` trace gap (500s on every route) — which is the whole reason
`deskmate deploy` uses `--prebuilt` + a patch. **Neither pure path works for a coding
deskmate.** This is the gap to close.

---

## Symptom (what the user sees)

A `coding`-enabled deskmate (e.g. the catalog `engineer` role) deploys fine, but any
invocation that loads its skill / touches its sandbox fails. Runtime logs show:

```
[eve:harness.tool-loop] tool execution failed { toolName: 'load_skill', ...
  SandboxTemplateNotProvisionedError: Sandbox template
  "eve-sbx-tpl-vercel-7c59f9cee7774c47-cd688dff09b794bfa991" is not provisioned for
  backend "vercel". Run `eve build` or invoke `prewarmAppSandboxes()` before serving traffic.
```

The front desk then returns a degraded/confused answer (the subagent turn failed).

## Root cause

eve provisions ("prewarms") each node's sandbox template as a side effect of `eve build`, but
**only when the build runs on Vercel**. The gate is in
`eve/dist/src/internal/nitro/host/vercel-build-prewarm.js`:

```js
function shouldPrewarmVercelBuild() {
  const v = process.env.VERCEL?.trim();
  const id = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  return !!v && !!id;   // BOTH required
}
// ...if skipped, eve warns:
// "Skipped Vercel sandbox template prewarm because VERCEL_DEPLOYMENT_ID is missing.
//  The generated .vercel/output may reference sandbox templates that were not provisioned.
//  Do not deploy it with 'vercel deploy --prebuilt'; use 'vercel deploy' so Vercel builds
//  from source."
```

`deskmate deploy` runs `vercel build` **locally** (`packages/cli/src/deploy.ts`). Locally
`VERCEL` is set by the CLI but `VERCEL_DEPLOYMENT_ID` is **not** → prewarm is skipped → the
prebuilt output references templates that don't exist → runtime `SandboxTemplateNotProvisionedError`.

Current `deploy()` (origin/main, `packages/cli/src/deploy.ts`) for reference:

```ts
// Step 0: vercel pull --yes --environment=production   (env snapshot)
await deps.sync(cwd);
// vercel build --prod   (VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1)  ← LOCAL build, no prewarm
const buildCode = await deps.run("vercel", ["build", "--prod", ...args], cwd, { VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1" });
const patched = deps.patch(cwd);                                  // fix eve #channel trace gap
return deps.run("vercel", ["deploy", "--prebuilt", "--prod", ...args], cwd);  // upload prebuilt
```

## The core tension (why this is non-trivial)

| Deploy style | Sandbox templates | Runtime routes |
|---|---|---|
| **prebuilt** (current `deskmate deploy`) | ❌ not provisioned (local build) | ✅ work (trace patched) |
| **source** (`vercel deploy`, builds on Vercel) | ✅ provisioned (`VERCEL_DEPLOYMENT_ID` set) | ❌ 500 — eve `#channel` trace gap |

Verified empirically on `addmein-deskmate` (2026-07-06): a source `vercel deploy` build log
shows `eve: initialized 6 sandbox templates (0 reused, 6 built)` **and** the resulting
deployment returns `FUNCTION_INVOCATION_FAILED` on `/` and `/eve/v1/slack` (consistent with the
`#channel` trace gap that `patchVercelEveTrace` exists to fix). So the trace gap is **still
present** at the current eve version — you cannot simply switch to a source deploy.

## Key facts (verified — build the fix on these)

1. **Templates are team-scoped, content-hashed named Vercel Sandboxes**, NOT deployment-scoped.
   The vercel backend (`eve/dist/src/execution/sandbox/bindings/vercel.js`) reads a template via
   `getNamedVercelSandbox({ sandboxName: templateKey })`, where `templateKey =
   eve-sbx-tpl-vercel-<contenthash>`. Consequence: **provisioning a template once (via any
   on-Vercel build of the same source) makes it available to a later `--prebuilt` deployment**
   whose runtime looks it up by the same hash. (Confirmed: a throwaway source *preview* build
   provisioned the templates the production prebuilt deploy needed.)
2. The template key is `createRuntimeSandboxTemplateKey({ backendName, compiledArtifactsSource,
   nodeId, sourceId, templatePlan })` — content-derived (bootstrap, seed files, base runtime).
   **Verify** the key is identical between a source build and the local prebuilt build of the
   same synced tree; if `compiledArtifactsSource` (disk vs bundled) perturbs the hash, a
   provision-then-prebuilt scheme won't line up.
3. `prewarmAppSandboxes()` is **internal** to eve (`#execution/sandbox/prewarm.js`) — it is NOT
   in eve's public `exports`. Only `SandboxTemplateNotProvisionedError` is public
   (`eve/sandbox`... actually `#public/definitions/sandbox-backend.js`). So calling prewarm
   directly from the deskmate CLI needs an **eve change to export it**.
4. There is **no `eve prewarm` / `eve sandbox` CLI subcommand** — only `eve build` and
   `eve deploy`. `eve deploy` also has the trace gap (that's why `deskmate deploy` exists).
5. Only teams with **at least one `coding` deskmate** have sandboxes. Non-coding teams are
   unaffected — the fix must be **conditional** so it doesn't slow/break normal deploys.

## Fix options

### Option A — two-phase deploy: provision via source, serve via prebuilt (deskmate-only)
In `deploy()`, when the team has a coding deskmate, first run a **source** `vercel deploy`
(no `--prebuilt`, target a non-prod/preview) purely to trigger eve's on-Vercel prewarm
(`VERCEL_DEPLOYMENT_ID` present) → provisions the team-scoped templates. Then run the existing
local `vercel build` + patch + `vercel deploy --prebuilt --prod`. The prod runtime resolves the
templates by content hash.
- **Pros:** pure Vercel CLI; no eve change; implementable today.
- **Cons:** two Vercel builds (slower/cost); the source deploy 500s (harmless, unaliased, but
  noisy — clean it up with `vercel remove`); **depends on Fact #2** (hash parity). Fragile if
  hashing differs between build modes — must verify.

### Option B — export + call `prewarmAppSandboxes()` (needs an eve change)
Get eve to export `prewarmAppSandboxes` publicly, then in `deploy()` (after the local
`vercel build` produces disk artifacts in `.vercel/output`) call it to provision templates via
the Vercel Sandbox API, no throwaway deploy.
- **Pros:** single build; clean; no 500ing preview.
- **Cons:** cross-repo (needs an eve release exposing prewarm); must confirm prewarm can talk to
  the Vercel Sandbox API from a local/CI context (auth via `VERCEL_TOKEN`/OIDC; the vercel
  backend prewarm may expect a deployment context). Prototype before committing.

### Option C — fix the eve `#channel` trace gap upstream, then drop `--prebuilt` (best long-term)
If eve's package `exports` / nitro dependency tracing followed the internal `#channel/*`
subpaths, a plain source `vercel deploy` would serve correctly **and** provision sandboxes via
`eve build`. Then `deskmate deploy` collapses to `pull → sync → vercel deploy` — no patch, no
prebuilt, no sandbox gap. This removes BOTH long-standing hacks.
- **Pros:** simplest end state; deletes `patchVercelEveTrace` and this whole problem.
- **Cons:** the fix lives in **eve**, not deskmate. deskmate can only adopt it once eve ships.
  But it's worth filing upstream and gating `deskmate deploy` on a capability check.

## Recommended approach

1. **File the eve trace-gap issue (Option C)** — it's the root of both the patch and this gap.
   Include the source-deploy `FUNCTION_INVOCATION_FAILED` repro + the `#channel/compiled-channel`
   `ERR_MODULE_NOT_FOUND` from the source deploy's runtime logs (grab these first — see
   Verification). If/when eve fixes it, `deskmate deploy` switches to source deploy and this is
   moot.
2. **Ship Option A now** as the deskmate-side fix (unblocks users today), **gated on a coding
   deskmate existing**, and **only after confirming Fact #2 (hash parity)**. If hashes don't
   line up, fall back to pursuing Option B with an eve export.
3. Add a **`doctor` check**: "coding deskmate present but sandbox templates not provisioned"
   (extends the existing `doctor` GitHub-App readiness check in `packages/cli/src/doctor.ts`).
   Ideally `deskmate deploy` runs this post-deploy and warns loudly if a coding deskmate's
   template is missing — turn a silent runtime crash into a deploy-time error.

## Code locations

- `packages/cli/src/deploy.ts` — `deploy()` orchestration (add the provisioning phase; gate on
  coding). `DeployDeps` is injected for unit-testing — add a `provisionSandboxes` seam and test
  it like the existing `sync`/`run`/`patch` deps in `packages/cli/test/deploy.test.ts`.
- `packages/cli/src/lib/load-config.ts` — to detect whether any deskmate has `coding` enabled
  (the gate). `coding` normalization lives in `packages/core/src/config.ts`.
- `packages/cli/src/doctor.ts` + `test/doctor.test.ts` — add the sandbox-provisioning check.
- eve (if Option B or C): `#execution/sandbox/prewarm.js` (export), and the `#channel` trace
  gap in eve's build/exports (Option C).

## Verification

1. **Confirm the source-deploy failure mode** (for the eve issue): `vercel deploy` a coding
   team, then read the **runtime** logs — expect `ERR_MODULE_NOT_FOUND` for an eve `#channel`
   / `compiled-channel.js` import. That pins it to the trace gap (not something else).
2. **Confirm hash parity** (for Option A): capture the `templateKey` printed/derived from a
   source build and from the local prebuilt build of the same synced tree; they must match.
3. **End-to-end**: with the fix, `deskmate deploy` a coding deskmate, then invoke it. It must
   reach its sandbox without `SandboxTemplateNotProvisionedError`. (Full coding also needs the
   GitHub App — `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_ORG`; provision that
   separately or the clone/PR steps stay unauthenticated.)
4. **Regression**: a non-coding team's `deskmate deploy` is unchanged (no extra build, same
   timing).

## Related (out of scope here, but note them)

- **`web_search` arg-parse bug (eve, not deskmate).** Seen alongside the sandbox error:
  `TypeError: Failed to parse tool-call arguments for "web_search" (...): Expected a
  JSON-serializable object.` at `resolveToolCallInputObject` in eve. It fails the task run when
  the model calls the built-in `web_search`. Reproduce and file upstream in eve.
- **Interim workaround for coding deskmates until this lands:** keep `coding` *off* (dormant) so
  the deskmate runs as a read/investigate role with no sandbox dependency, and turn it on only
  once (a) the GitHub App is configured and (b) the sandbox templates are provisioned by
  whichever fix ships. (This is what `addmein-deskmate` does now.)

## Appendix — evidence

- Prewarm gate: `eve/dist/src/internal/nitro/host/vercel-build-prewarm.js` → `shouldPrewarmVercelBuild()`.
- Template lookup (team-scoped, by name/hash): `eve/dist/src/execution/sandbox/bindings/vercel.js`
  → `readTemplate()` / `getNamedVercelSandbox({ sandboxName: templateKey })`.
- Template key: `createRuntimeSandboxTemplateKey(...)` in `eve/dist/src/execution/sandbox/prewarm.js`.
- Source build log (provisioning works on Vercel): `eve: initializing 6 sandbox templates...` /
  `eve: sandbox template "subagents/<id>" (vercel): preparing base runtime inside sandbox` /
  `eve: initialized 6 sandbox templates (0 reused, 6 built).`
- Source deploy runtime: `HTTP 500 FUNCTION_INVOCATION_FAILED` on `/` and `/eve/v1/slack`.
- Current deploy flow: `packages/cli/src/deploy.ts` `deploy()` (quoted above).
