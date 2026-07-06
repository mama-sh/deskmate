import { syncCommand } from "./sync/index.js";
import { patchVercelEveTrace } from "./lib/vercel-trace.js";
import { runCommand } from "./lib/run.js";

// Re-exported so both `deskmate deploy` and `deskmate connect` share one spawn
// seam (see `./lib/run.ts`); `deploy.test.ts` keeps importing it from here.
export { runCommand } from "./lib/run.js";

/** Side effects `deploy()` needs — injected so the orchestration is unit-testable. */
export interface DeployDeps {
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  /** Run a command to completion; resolves with its exit code. */
  run: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
  /** Patch the eve trace in `.vercel/output`; returns the patched function dirs. */
  patch: (cwd: string) => string[];
}

const defaultDeps: DeployDeps = {
  sync: syncCommand,
  run: runCommand,
  patch: patchVercelEveTrace,
};

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

  const buildCode = await deps.run("vercel", ["build", "--prod", ...args], cwd, {
    VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
  });
  if (buildCode !== 0) return buildCode;

  const patched = deps.patch(cwd);
  console.log(`✓ eve-trace: patched ${patched.length} function bundle(s)`);

  return deps.run("vercel", ["deploy", "--prebuilt", "--prod", ...args], cwd);
}
