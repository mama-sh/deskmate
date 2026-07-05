import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Absolute path to the `eve` CLI entry, resolved from the CONSUMER's project
 * (`cwd`) — not from @deskmate/cli's own node_modules. `deskmate dev` spawns this
 * with `node <path> dev …`. Throws a clear install hint when eve isn't a dependency.
 */
export function resolveEveBin(cwd: string): string {
  // A file URL inside cwd is the module-resolution base; the file need not exist.
  const require = createRequire(pathToFileURL(join(cwd, "__deskmate_resolve__.js")));
  let pkgPath: string;
  try {
    pkgPath = require.resolve("eve/package.json");
  } catch {
    throw new Error(
      "eve isn't installed in this project — run `npm install eve` (or pnpm/yarn add) first.",
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.eve;
  if (!bin) throw new Error(`the installed eve package has no \`bin.eve\` (${pkgPath}).`);
  return join(dirname(pkgPath), bin);
}
