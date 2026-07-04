import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_FUNCTIONS = join(".vercel", "output", "functions");

/**
 * Absolute path to the resolved `eve` package directory in the CONSUMER's project
 * (`cwd`) — not @deskmate/cli's own node_modules. Throws a clear install hint when
 * eve isn't a dependency.
 */
export function resolveEveDir(cwd: string): string {
  const require = createRequire(pathToFileURL(join(cwd, "__deskmate_resolve__.js")));
  let pkgPath: string;
  try {
    pkgPath = require.resolve("eve/package.json");
  } catch {
    throw new Error(
      "eve isn't installed in this project — run `npm install eve` (or pnpm/yarn add) first.",
    );
  }
  return dirname(pkgPath);
}

/** Every `*.func` directory under `.vercel/output/functions` (recursive), sorted. */
export function findVercelFunctions(cwd: string): string[] {
  const root = join(cwd, OUTPUT_FUNCTIONS);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (!statSync(abs).isDirectory()) continue;
      if (name.endsWith(".func")) out.push(abs);
      else walk(abs);
    }
  };
  walk(root);
  return out;
}

/** Side effects, injected so the patch is unit-testable against a fixture. */
export interface EveTracePatchDeps {
  resolveEve: (cwd: string) => string;
  findFunctions: (cwd: string) => string[];
  /** Overlay eve's own files (package.json + dist) into a function's node_modules/eve. */
  copyEve: (eveDir: string, funcEveDir: string) => void;
}

/** Overlay eve's own files (package.json + dist) into a function's node_modules/eve. */
export function copyEvePackage(eveDir: string, funcEveDir: string): void {
  // `dereference` so real files (not pnpm-store symlinks) land in the bundle.
  cpSync(join(eveDir, "package.json"), join(funcEveDir, "package.json"), { dereference: true });
  cpSync(join(eveDir, "dist"), join(funcEveDir, "dist"), {
    recursive: true,
    dereference: true,
    force: true,
  });
}

const defaultDeps: EveTracePatchDeps = {
  resolveEve: resolveEveDir,
  findFunctions: findVercelFunctions,
  copyEve: copyEvePackage,
};

/**
 * Make a `vercel build` output self-contained for eve.
 *
 * Vercel's Node file tracer doesn't follow eve's package-internal `#…` subpath
 * imports (package.json `imports`), so any `.vercel/output/functions/*.func` that
 * externalizes `eve` ships WITHOUT the files reachable only that way — e.g.
 * `eve/dist/src/channel/compiled-channel.js`, imported by
 * `eve/dist/src/public/channels/index.js` via `#channel/*`. The function then
 * crashes at boot with `ERR_MODULE_NOT_FOUND` on every route (both the HTTP
 * function and the durable-workflow function).
 *
 * Overlaying eve's full `dist` (+ package.json) into each such function restores
 * the missing files. Idempotent. Run AFTER `vercel build`, BEFORE
 * `vercel deploy --prebuilt` (this is what `deskmate deploy` does).
 *
 * Remove once the upstream eve/Vercel tracing gap is closed.
 *
 * @returns the function directories that were patched.
 */
export function patchVercelEveTrace(cwd: string, deps: EveTracePatchDeps = defaultDeps): string[] {
  const functions = deps.findFunctions(cwd);
  const patched: string[] = [];
  let eveDir: string | undefined;
  for (const func of functions) {
    const funcEveDir = join(func, "node_modules", "eve");
    // eve is only externalized into some functions; skip the ones that bundled it.
    if (!existsSync(funcEveDir)) continue;
    eveDir ??= deps.resolveEve(cwd);
    deps.copyEve(eveDir, funcEveDir);
    patched.push(func);
  }
  return patched;
}
