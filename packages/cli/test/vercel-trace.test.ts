import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findVercelFunctions,
  copyEvePackage,
  patchVercelEveTrace,
} from "../src/lib/vercel-trace.js";

let root: string;

function touch(path: string, contents = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deskmate-vtrace-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findVercelFunctions", () => {
  it("finds *.func dirs recursively, sorted; empty when no output", () => {
    expect(findVercelFunctions(root)).toEqual([]);
    const fns = join(root, ".vercel", "output", "functions");
    mkdirSync(join(fns, "__server.func"), { recursive: true });
    mkdirSync(join(fns, ".well-known", "workflow", "v1", "flow.func"), { recursive: true });
    mkdirSync(join(fns, "static"), { recursive: true }); // not a .func — ignored
    expect(findVercelFunctions(root)).toEqual([
      join(fns, ".well-known", "workflow", "v1", "flow.func"),
      join(fns, "__server.func"),
    ]);
  });
});

describe("patchVercelEveTrace", () => {
  it("overlays eve's dist into every function that externalized eve, skips the rest", () => {
    // A fixture eve package whose channel file NFT would have dropped.
    const eveDir = join(root, "fixture-eve");
    touch(join(eveDir, "package.json"), '{"name":"eve"}');
    touch(join(eveDir, "dist", "src", "channel", "compiled-channel.js"), "export const x = 1;");

    const fns = join(root, ".vercel", "output", "functions");
    // Two functions externalize eve but are MISSING the channel file (the bug).
    const server = join(fns, "__server.func");
    const flow = join(fns, ".well-known", "workflow", "v1", "flow.func");
    touch(join(server, "node_modules", "eve", "dist", "src", "public", "channels", "index.js"), "");
    touch(join(flow, "node_modules", "eve", "dist", "src", "public", "channels", "index.js"), "");
    // A third function does NOT externalize eve — must be left untouched.
    const staticFn = join(fns, "static.func");
    touch(join(staticFn, "index.js"), "");

    const patched = patchVercelEveTrace(root, {
      resolveEve: () => eveDir,
      findFunctions: findVercelFunctions,
      copyEve: copyEvePackage,
    });

    // Both eve-carrying functions get the missing channel file; the static one doesn't.
    expect(existsSync(join(server, "node_modules", "eve", "dist", "src", "channel", "compiled-channel.js"))).toBe(true);
    expect(existsSync(join(flow, "node_modules", "eve", "dist", "src", "channel", "compiled-channel.js"))).toBe(true);
    expect(existsSync(join(staticFn, "node_modules", "eve"))).toBe(false);
    expect(patched.sort()).toEqual([flow, server].sort());
  });

  it("is a no-op (resolveEve never called) when no function carries eve", () => {
    const fns = join(root, ".vercel", "output", "functions");
    touch(join(fns, "static.func", "index.js"), "");
    let resolved = false;
    const patched = patchVercelEveTrace(root, {
      resolveEve: () => {
        resolved = true;
        return "/never";
      },
      findFunctions: findVercelFunctions,
      copyEve: copyEvePackage,
    });
    expect(patched).toEqual([]);
    expect(resolved).toBe(false);
  });
});
