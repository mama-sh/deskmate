import type { TeamConfig } from "@deskmate/core";
import { syncCommand } from "./sync/index.js";
import { patchVercelEveTrace } from "./lib/vercel-trace.js";
import { runCommand } from "./lib/run.js";
import { loadTeam } from "./lib/load-config.js";

// Re-exported so both `deskmate deploy` and `deskmate connect` share one spawn
// seam (see `./lib/run.ts`); `deploy.test.ts` keeps importing it from here.
export { runCommand } from "./lib/run.js";

/** Side effects `deploy()` needs — injected so the orchestration is unit-testable. */
export interface DeployDeps {
  /** Load + validate the team config (to detect whether any deskmate has `coding`). */
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  /** Run a command to completion; resolves with its exit code. */
  run: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
  /** Patch the eve trace in `.vercel/output`; returns the patched function dirs. */
  patch: (cwd: string) => string[];
}

const defaultDeps: DeployDeps = {
  loadTeam,
  sync: syncCommand,
  run: runCommand,
  patch: patchVercelEveTrace,
};

/**
 * Drop target/prebuilt flags from passthrough args for the SOURCE provisioning deploy.
 * The provisioning deploy must stay an unaliased preview built from source — a leaked
 * `--prod`/`--target` would ship the un-patched (trace-broken) build to production, and
 * `--prebuilt` would defeat the whole point (no on-Vercel build → no prewarm). Auth/scope
 * flags pass through untouched — note `-t` is Vercel's shorthand for `--token` (a global
 * auth flag), NOT `--target` (which has no short form), so it must be preserved.
 */
function provisionArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prod" || a === "--prebuilt") continue;
    if (a === "--target") { i++; continue; } // --target <value>: skip the flag AND its value
    if (a.startsWith("--target=")) continue;
    out.push(a);
  }
  return out;
}

/**
 * `deskmate deploy [...vercel-deploy-args]`: the known-good recipe to ship an eve
 * team to Vercel production.
 *
 *   pull → sync → `vercel build` (experimental frameworks) → patch eve trace → `vercel deploy --prebuilt`
 *
 * Plain `vercel deploy` / `eve deploy` build a function that drops eve's internal
 * `#…` files (see `patchVercelEveTrace`) and 500s on every route. Building locally
 * and patching the output before a `--prebuilt` upload sidesteps that. Passthrough
 * args (e.g. `--yes`, `--token`, `--scope`) go to `vercel pull`, `vercel build`, AND
 * `vercel deploy` — each step needs the same auth/scope in CI. Note `vercel pull`
 * accepts a narrower flag set than build/deploy, so a deploy-only flag like
 * `--target` is rejected there first (harmless here — the recipe is `--prod`-pinned).
 *
 * Requires the Vercel CLI installed and authenticated (`vercel login`).
 */
export async function deploy(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: DeployDeps = defaultDeps,
): Promise<number> {
  // Step 0: pull the production env so `vercel build` validates connections against
  // the REAL deploy env, not a stale `.vercel/.env.production.local`. Fail-fast — a
  // misconfigured connection URL/token surfaces here, locally, instead of shipping a
  // bot that 500s on first use. The full passthrough reaches pull (it needs the same
  // auth/scope in CI); the xfw env keeps framework/settings resolution consistent
  // with the build below.
  const pullCode = await deps.run(
    "vercel",
    ["pull", "--yes", "--environment=production", ...args],
    cwd,
    { VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1" },
  );
  if (pullCode !== 0) return pullCode;

  await deps.sync(cwd);

  // eve provisions ("prewarms") each coding deskmate's Vercel Sandbox template only during a
  // build that runs ON Vercel (it gates on VERCEL_DEPLOYMENT_ID). Our LOCAL `vercel build` +
  // `--prebuilt` upload therefore references templates that were never created → the deskmate
  // throws SandboxTemplateNotProvisionedError on its first coding turn. So for a coding team,
  // first run a SOURCE `vercel deploy` (no --prebuilt, no --prod) — Vercel builds it and eve
  // prewarms the team-scoped templates — then the prebuilt prod deploy below resolves them by
  // content hash. Non-coding teams have no sandboxes and skip this entirely.
  const team = await deps.loadTeam(cwd);
  const hasCoding = Object.values(team.deskmates).some((d) => d.coding);
  if (hasCoding) {
    const provisionCode = await deps.run("vercel", ["deploy", ...provisionArgs(args)], cwd, {
      VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
    });
    // A non-zero exit means the on-Vercel build failed — abort rather than ship a coding bot
    // whose sandboxes aren't provisioned (turns a silent runtime crash into a deploy error).
    if (provisionCode !== 0) return provisionCode;
    console.log(
      "✓ provisioned coding sandbox templates via a source build " +
        "(the preview 500s harmlessly and is unaliased — `vercel remove` it if you like).",
    );
  }

  const buildCode = await deps.run("vercel", ["build", "--prod", ...args], cwd, {
    VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
  });
  if (buildCode !== 0) return buildCode;

  const patched = deps.patch(cwd);
  console.log(`✓ eve-trace: patched ${patched.length} function bundle(s)`);

  const deployCode = await deps.run("vercel", ["deploy", "--prebuilt", "--prod", ...args], cwd);
  if (deployCode === 0 && hasCoding) {
    console.log(
      "\nℹ coding deskmate deployed. Set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_ORG " +
        "in the deploy env, or the clone/PR steps stay unauthenticated. Verify readiness with `deskmate doctor`.",
    );
  }
  return deployCode;
}
