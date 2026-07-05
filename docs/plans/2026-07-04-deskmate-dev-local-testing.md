# `deskmate dev` — Local Testing Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a `deskmate dev` CLI command that runs `deskmate sync`, launches `eve dev` for a local chat with your configured team, and re-syncs automatically as you edit the config.

**Architecture:** A new `dev()` orchestrator (`packages/cli/src/dev.ts`) that (1) syncs once, fail-fast on invalid config; (2) resolves and spawns the consumer's `eve` binary with `stdio: "inherit"`; (3) watches `deskmate.config.ts` + `roles/**` and re-syncs quietly on change (eve dev's HMR reloads the regenerated `agent/**`). A URL arg proxies straight to `eve dev` (nothing local to reload). All side effects are behind an injectable deps object so the orchestrator is unit-testable without spawning eve or calling a model.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥24, Vitest, `node:child_process`, `node:fs`, `node:module` (`createRequire`).

**Design doc:** `docs/plans/2026-07-04-deskmate-dev-local-testing-design.md`

**Conventions to match (read these first):**
- Commands are plain functions taking `cwd = process.cwd()` — see `packages/cli/src/list.ts`, `packages/cli/src/sync/index.ts`.
- `createRequire(import.meta.url)` for resolving a dependency — see `packages/cli/src/sync/render.ts:1,10`.
- Tests use real tmpdirs (`mkdtempSync(join(tmpdir(), "deskmate-…"))`) with `beforeEach`/`afterEach` cleanup — see `packages/cli/test/add.test.ts`.
- Every commit message ends with the co-author trailer (see each Commit step).

---

## Task 1: Add a `{ quiet }` option to `syncCommand`

So watch-mode re-syncs don't corrupt the interactive `eve dev` TUI. Default is unchanged behavior.

**Files:**
- Modify: `packages/cli/src/sync/index.ts`
- Test: `packages/cli/test/sync.test.ts`

**Step 1: Write the failing test**

Add to `packages/cli/test/sync.test.ts` (inside the existing top-level `describe`, or a new one). It needs a valid `deskmate.config.ts` + a role on disk; reuse the fixture setup already in that file (mirror how the existing test builds `cwd`). The assertion: with `{ quiet: true }`, `console.log` is not called, but files are still written.

```ts
import { vi } from "vitest";

it("quiet mode writes files but prints nothing", async () => {
  // `cwd` here must already contain a valid deskmate.config.ts + roles/<id>/,
  // set up the same way as the other tests in this file.
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await syncCommand(cwd, { quiet: true });
  } finally {
    logSpy.mockRestore();
  }
  expect(logSpy).not.toHaveBeenCalled();
  expect(existsSync(join(cwd, "agent", "agent.ts"))).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/cli test -- sync.test.ts`
Expected: FAIL — `syncCommand` currently ignores the 2nd arg and still calls `console.log`.

**Step 3: Write minimal implementation**

In `packages/cli/src/sync/index.ts`, change the signature and gate the two `console.log` sites:

```ts
export async function syncCommand(
  cwd: string = process.cwd(),
  opts: { quiet?: boolean } = {},
): Promise<void> {
  // …unchanged body up to the final logging…

  if (!opts.quiet) {
    console.log(
      `✓ deskmate sync: wrote ${plan.writes.length} file(s), removed ${plan.deletes.length} stale subagent dir(s).`,
    );
    for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/cli test -- sync.test.ts`
Expected: PASS. Also confirm the existing sync tests still pass (default path unchanged).

**Step 5: Commit**

```bash
git add packages/cli/src/sync/index.ts packages/cli/test/sync.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add quiet option to syncCommand

Suppresses the summary/warning logs so watch-mode re-syncs don't corrupt
the interactive eve dev TUI. Default (quiet: false) is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `resolveEveBin` — find the consumer's `eve` binary

**Files:**
- Create: `packages/cli/src/lib/eve-bin.ts`
- Test: `packages/cli/test/eve-bin.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "eve", version: "0.0.0", bin: { eve: bin }, exports: { "./package.json": "./package.json" } }));
  writeFileSync(join(pkgDir, "bin", "eve.js"), "#!/usr/bin/env node\n");
}

describe("resolveEveBin", () => {
  it("returns the absolute path to eve's bin", () => {
    fakeEve(cwd);
    const resolved = resolveEveBin(cwd);
    expect(resolved).toBe(join(cwd, "node_modules", "eve", "bin", "eve.js"));
  });

  it("throws an install hint when eve is not installed", () => {
    expect(() => resolveEveBin(cwd)).toThrow(/eve isn't installed/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/cli test -- eve-bin.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write minimal implementation**

`eve/package.json` is exported by eve (verified), so `require.resolve("eve/package.json")` works. Resolve from a path inside `cwd` so we find the *consumer's* eve.

```ts
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
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/cli test -- eve-bin.test.ts`
Expected: PASS (both cases).

**Step 5: Commit**

```bash
git add packages/cli/src/lib/eve-bin.ts packages/cli/test/eve-bin.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): resolve the consumer's eve binary

resolveEveBin(cwd) locates eve's CLI entry from the consumer project so
`deskmate dev` can spawn it, with a clear install hint when eve is missing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `dev()` orchestrator (pure logic, injected side effects)

**Files:**
- Create: `packages/cli/src/dev.ts`
- Test: `packages/cli/test/dev.test.ts`

**Step 1: Write the failing test** — `isRemoteTarget` (pure helper first)

```ts
import { describe, it, expect, vi } from "vitest";
import { isRemoteTarget, dev, type DevDeps } from "../src/dev.js";

describe("isRemoteTarget", () => {
  it("is true when an http(s) URL is passed", () => {
    expect(isRemoteTarget(["https://app.vercel.app"])).toBe(true);
    expect(isRemoteTarget(["--no-ui", "http://localhost:3000"])).toBe(true);
  });
  it("is false for local dev (flags only, or empty)", () => {
    expect(isRemoteTarget([])).toBe(false);
    expect(isRemoteTarget(["--no-ui"])).toBe(false);
  });
});
```

**Step 2: Write the failing test** — `dev()` orchestration with fakes

A fake eve child is an object exposing `on("exit", …)`, `kill()`, plus a test-only `emitExit(code)` to simulate eve quitting. A fake `watchConfig` captures the `onChange` callback and hands back a `trigger()` so the test can simulate a config edit.

```ts
function makeDeps(overrides: Partial<DevDeps> = {}) {
  const calls: string[] = [];
  let childExit: (code: number | null) => void = () => {};
  let onChange: () => void = () => {};
  const closeWatch = vi.fn();

  const deps: DevDeps = {
    sync: vi.fn(async (_cwd, opts) => { calls.push(opts?.quiet ? "sync:quiet" : "sync"); }),
    resolveEve: vi.fn(() => "/fake/eve.js"),
    spawnEve: vi.fn((_bin, args, _cwd) => {
      calls.push(`spawn:${args.join(" ")}`);
      return {
        on: (_e: "exit", cb: (code: number | null) => void) => { childExit = cb; },
        kill: vi.fn(),
      };
    }),
    watchConfig: vi.fn((_cwd, cb) => { onChange = cb; return { close: closeWatch }; }),
    ...overrides,
  };
  return { deps, calls, closeWatch, emitExit: (c: number | null) => childExit(c), triggerChange: () => onChange() };
}

describe("dev", () => {
  it("syncs once, then spawns `eve dev` with passthrough args, then exits with eve's code", async () => {
    const { deps, calls, emitExit } = makeDeps();
    const p = dev(["--no-ui"], "/proj", deps);
    // let the initial sync + spawn settle, then simulate eve exiting 0
    await Promise.resolve();
    emitExit(0);
    await expect(p).resolves.toBe(0);
    expect(calls).toEqual(["sync", "spawn:dev --no-ui"]); // sync BEFORE spawn
  });

  it("re-syncs quietly on a config change without killing eve", async () => {
    const { deps, calls, emitExit, triggerChange } = makeDeps();
    const p = dev([], "/proj", deps);
    await Promise.resolve();
    triggerChange();               // simulate editing deskmate.config.ts
    await Promise.resolve();
    expect(calls).toContain("sync:quiet");
    emitExit(0);
    await p;
  });

  it("keeps eve running when a re-sync throws (invalid config saved mid-edit)", async () => {
    const sync = vi.fn()
      .mockResolvedValueOnce(undefined)                 // initial ok
      .mockRejectedValueOnce(new Error("invalid config")); // edit is broken
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, emitExit, triggerChange } = makeDeps({ sync });
    const p = dev([], "/proj", deps);
    await Promise.resolve();
    triggerChange();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid config/));
    emitExit(0);                    // eve still alive → can exit normally
    await p;
    warn.mockRestore();
  });

  it("fails fast (no spawn) when the initial sync throws", async () => {
    const sync = vi.fn().mockRejectedValueOnce(new Error("bad config"));
    const { deps } = makeDeps({ sync });
    await expect(dev([], "/proj", deps)).rejects.toThrow(/bad config/);
    expect(deps.spawnEve).not.toHaveBeenCalled();
  });

  it("proxies straight to eve dev (no sync, no watch) for a remote URL target", async () => {
    const { deps, calls, emitExit } = makeDeps();
    const p = dev(["https://app.vercel.app"], "/proj", deps);
    await Promise.resolve();
    emitExit(0);
    await p;
    expect(deps.sync).not.toHaveBeenCalled();
    expect(deps.watchConfig).not.toHaveBeenCalled();
    expect(calls).toEqual(["spawn:dev https://app.vercel.app"]);
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `pnpm --filter @deskmate/cli test -- dev.test.ts`
Expected: FAIL — `dev.ts` doesn't exist.

**Step 4: Write minimal implementation**

```ts
import { spawn } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { syncCommand } from "./sync/index.js";
import { resolveEveBin } from "./lib/eve-bin.js";
import { CONFIG_FILE } from "./sync/index.js";

/** Minimal shape of the spawned eve child that `dev()` relies on. */
export interface EveChild {
  on(event: "exit", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}

/** Side effects `dev()` needs — injected so the orchestration is unit-testable. */
export interface DevDeps {
  sync: (cwd: string, opts?: { quiet?: boolean }) => Promise<void>;
  resolveEve: (cwd: string) => string;
  spawnEve: (eveBin: string, args: string[], cwd: string) => EveChild;
  watchConfig: (cwd: string, onChange: () => void) => { close: () => void };
}

/** True when args carry an http(s) URL — eve dev drives a deployment, nothing local to reload. */
export function isRemoteTarget(args: string[]): boolean {
  return args.some((a) => /^https?:\/\//.test(a));
}

const defaultDeps: DevDeps = {
  sync: syncCommand,
  resolveEve: resolveEveBin,
  spawnEve: (eveBin, args, cwd) =>
    spawn(process.execPath, [eveBin, "dev", ...args], { stdio: "inherit", cwd }),
  watchConfig: (cwd, onChange) => watchConfigDefault(cwd, onChange),
};

/**
 * `deskmate dev [...args]`: sync the config → chat with the team via `eve dev`,
 * re-syncing on every config edit so the running agent updates live.
 */
export async function dev(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: DevDeps = defaultDeps,
): Promise<number> {
  const eveBin = deps.resolveEve(cwd);

  // Remote target: nothing local to reload — just proxy to eve dev.
  if (isRemoteTarget(args)) {
    return waitForExit(deps.spawnEve(eveBin, args, cwd));
  }

  // Initial sync: fail fast on an invalid config (don't launch eve on a broken tree).
  await deps.sync(cwd, { quiet: false });

  const child = deps.spawnEve(eveBin, args, cwd);

  // Watch config + roles/**; re-sync quietly on change. A broken save warns but
  // does NOT kill eve — fix and save again.
  const watcher = deps.watchConfig(cwd, () => {
    deps.sync(cwd, { quiet: true }).catch((err: unknown) => {
      console.error(`⚠ re-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // Ctrl+C / termination: forward to eve so it tears down cleanly.
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    return await waitForExit(child);
  } finally {
    watcher.close();
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

function waitForExit(child: EveChild): Promise<number> {
  return new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}

/** Real watcher: debounced fs.watch over deskmate.config.ts + roles/**. */
function watchConfigDefault(cwd: string, onChange: () => void): { close: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };
  const watchers = [
    fsWatch(join(cwd, CONFIG_FILE), debounced),
    fsWatch(join(cwd, "roles"), { recursive: true }, debounced),
  ];
  return {
    close: () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
```

> Note: importing `CONFIG_FILE` from `./sync/index.js` (already exported there). If the `roles/` dir may be absent, wrap its `fsWatch` in a try/catch inside `watchConfigDefault` so `dev` still runs config-only projects — add that only if a test surfaces it (YAGNI otherwise).

**Step 5: Run tests to verify they pass**

Run: `pnpm --filter @deskmate/cli test -- dev.test.ts`
Expected: PASS (all cases). Then `pnpm --filter @deskmate/cli typecheck`.

**Step 6: Commit**

```bash
git add packages/cli/src/dev.ts packages/cli/test/dev.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add deskmate dev orchestrator

Syncs the config, spawns the consumer's `eve dev`, and re-syncs quietly on
config/roles edits so the running agent updates live. Side effects are
injected so the orchestration is unit-tested without spawning eve.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `dev` into the CLI

**Files:**
- Modify: `packages/cli/src/cli.ts`

**Step 1: Write the failing test** — none (thin dispatch). Instead verify by hand in Step 4. (The dispatch mirrors the existing `sync` case; `dev.ts` is already covered.)

**Step 2: Implement**

In `packages/cli/src/cli.ts`, add the import, the USAGE line, and the case. `dev` returns an exit code — set `process.exitCode` from it:

```ts
import { dev } from "./dev.js";
```

Add to `USAGE` (after the `sync` line):

```ts
"  deskmate dev              sync + eve dev with live re-sync on config edits",
```

Add the case (before `default:`):

```ts
    case "dev":
      process.exitCode = await dev(rest);
      break;
```

**Step 3: Build the CLI**

Run: `pnpm --filter @deskmate/cli build`
Expected: compiles cleanly (`tsc` + postbuild).

**Step 4: Manual smoke — usage + fail-fast**

Run (from repo root, Node ≥24):
```bash
node packages/cli/bin/deskmate.mjs            # prints USAGE incl. the new `dev` line
cd /tmp && node <repo>/packages/cli/bin/deskmate.mjs dev   # no config → clear error, exit 1
```
Expected: usage lists `deskmate dev`; running `dev` with no `deskmate.config.ts` prints the "no deskmate.config.ts found" error and exits non-zero (fail-fast, before any eve spawn).

**Step 5: Commit**

```bash
git add packages/cli/src/cli.ts
git commit -m "$(cat <<'EOF'
feat(cli): wire up the deskmate dev command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Dogfood in the starter + document it

**Files:**
- Modify: `examples/starter/package.json`
- Modify: `README.md`

**Step 1: Add the starter script**

In `examples/starter/package.json` `scripts`, add:

```json
"dev": "deskmate dev",
```

**Step 2: Update the README "test locally" section**

Find the block around README L119–123 (the `eve dev` instructions). Lead with `deskmate dev` and keep `eve dev` as the lower-level alternative. Replace the block with:

```md
Test your team locally — regenerate the agent tree from `deskmate.config.ts` and
open a chat with the front desk + deskmates. `deskmate dev` re-syncs automatically
as you edit the config, so changes go live without a restart (Slack itself can't
reach localhost — see Caveats):

```bash
deskmate dev   # deskmate sync + eve dev; edits to deskmate.config.ts reload live
```

Under the hood that's `deskmate sync` followed by `eve dev` (local TUI + HTTP
session endpoint; pick a model with `/model`). Point it at a deployment with
`deskmate dev https://your-app.vercel.app`.
```

Keep the existing Caveats note (README ~L394) that Slack can't be tested on localhost; optionally update its `eve dev` reference to mention `deskmate dev`.

**Step 3: Verify docs build/read**

Run: `git diff README.md examples/starter/package.json` and re-read the edited section for accuracy (command names, flags).

**Step 4: Full check**

Run from repo root:
```bash
pnpm -w run build:packages && pnpm -r typecheck && pnpm -r test
```
Expected: packages build, typecheck clean, all tests pass (new `dev`, `eve-bin`, `sync` quiet tests included).

**Step 5: Commit**

```bash
git add examples/starter/package.json README.md
git commit -m "$(cat <<'EOF'
docs(cli): document deskmate dev as the local testing loop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Definition of done

- `deskmate dev` runs `sync`, launches `eve dev`, and re-syncs on config/roles edits.
- Invalid config at startup fails fast (no eve); invalid config mid-edit warns and keeps eve running.
- A URL arg proxies straight to `eve dev`.
- `resolveEveBin` finds the consumer's eve or prints an install hint.
- Unit tests cover the orchestrator, `isRemoteTarget`, `resolveEveBin`, and `syncCommand({ quiet })` — no eve spawn, no model calls.
- `pnpm -r typecheck` and `pnpm -r test` pass; the starter has a `dev` script; the README leads with `deskmate dev`.
