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
 *   sync → `vercel build` (experimental frameworks) → patch eve trace → `vercel deploy --prebuilt`
 *
 * Plain `vercel deploy` / `eve deploy` build a function that drops eve's internal
 * `#…` files (see `patchVercelEveTrace`) and 500s on every route. Building locally
 * and patching the output before a `--prebuilt` upload sidesteps that. Passthrough
 * args (e.g. `--yes`, `--token`, `--scope`) go to BOTH `vercel build` and
 * `vercel deploy` — the build runs first and needs the same auth/scope in CI.
 *
 * Requires the Vercel CLI installed and authenticated (`vercel login`).
 */
export async function deploy(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: DeployDeps = defaultDeps,
): Promise<number> {
  await deps.sync(cwd);

  const buildCode = await deps.run("vercel", ["build", "--prod", ...args], cwd, {
    VERCEL_USE_EXPERIMENTAL_FRAMEWORKS: "1",
  });
  if (buildCode !== 0) return buildCode;

  const patched = deps.patch(cwd);
  console.log(`✓ eve-trace: patched ${patched.length} function bundle(s)`);

  return deps.run("vercel", ["deploy", "--prebuilt", "--prod", ...args], cwd);
}
