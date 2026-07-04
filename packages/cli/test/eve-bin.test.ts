import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEveBin } from "../src/lib/eve-bin.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "deskmate-evebin-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** Write a minimal node_modules/eve package with a bin field. */
function fakeEve(root: string, bin = "./bin/eve.js") {
  const pkgDir = join(root, "node_modules", "eve");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "eve", version: "0.0.0", bin: { eve: bin }, exports: { "./package.json": "./package.json" } }),
  );
  writeFileSync(join(pkgDir, "bin", "eve.js"), "#!/usr/bin/env node\n");
}

describe("resolveEveBin", () => {
  it("returns the absolute path to eve's bin", () => {
    fakeEve(cwd);
    const resolved = resolveEveBin(cwd);
    // require.resolve canonicalizes symlinks (macOS tmpdir /var → /private/var),
    // so compare against the realpath of cwd.
    expect(resolved).toBe(join(realpathSync(cwd), "node_modules", "eve", "bin", "eve.js"));
  });

  it("throws an install hint when eve is not installed", () => {
    expect(() => resolveEveBin(cwd)).toThrow(/eve isn't installed/i);
  });
});
