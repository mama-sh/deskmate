import { spawn } from "node:child_process";

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
