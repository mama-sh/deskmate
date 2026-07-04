import { spawn } from "node:child_process";
import { syncCommand } from "./sync/index.js";
import { patchVercelEveTrace } from "./lib/vercel-trace.js";

/** Side effects `deploy()` needs — injected so the orchestration is unit-testable. */
export interface DeployDeps {
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  /** Run a command to completion; resolves with its exit code. */
  run: (cmd: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<number>;
  /** Patch the eve trace in `.vercel/output`; returns the patched function dirs. */
  patch: (cwd: string) => string[];
}

/**
 * Run a command to completion, resolving with its exit code. Never hangs and
 * never reports a failed run as success:
 * - a spawn failure (e.g. the Vercel CLI isn't installed / not on PATH) emits
 *   "error", not "exit" → resolve 127 instead of leaving the Promise pending;
 * - a signal-terminated child reports `code === null` → resolve 1 (failure) so an
 *   interrupted build can't fall through to patch + deploy stale `.vercel/output`.
 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.on("error", (err) => {
      console.error(`✗ could not run \`${cmd}\`: ${err instanceof Error ? err.message : String(err)}`);
      resolve(127);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
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
