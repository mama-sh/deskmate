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

function makeDeps(overrides: Partial<DevDeps> = {}) {
  const calls: string[] = [];
  let childExit: (code: number | null) => void = () => {};
  let onChange: () => void = () => {};
  const closeWatch = vi.fn();

  const deps: DevDeps = {
    sync: vi.fn(async (_cwd, opts) => {
      calls.push(opts?.quiet ? "sync:quiet" : "sync");
    }),
    resolveEve: vi.fn(() => "/fake/eve.js"),
    spawnEve: vi.fn((_bin, args, _cwd) => {
      calls.push(`spawn:${args.join(" ")}`);
      return {
        on: (_e: "exit", cb: (code: number | null) => void) => {
          childExit = cb;
        },
        kill: vi.fn(),
      };
    }),
    watchConfig: vi.fn((_cwd, cb) => {
      onChange = cb;
      return { close: closeWatch };
    }),
    ...overrides,
  };
  return {
    deps,
    calls,
    closeWatch,
    emitExit: (c: number | null) => childExit(c),
    triggerChange: () => onChange(),
  };
}

describe("dev", () => {
  it("syncs once, then spawns `eve dev` with passthrough args, then exits with eve's code", async () => {
    const { deps, calls, closeWatch, emitExit } = makeDeps();
    const p = dev(["--no-ui"], "/proj", deps);
    await Promise.resolve();
    emitExit(0);
    await expect(p).resolves.toBe(0);
    expect(calls).toEqual(["sync", "spawn:dev --no-ui"]); // sync BEFORE spawn
    expect(closeWatch).toHaveBeenCalled(); // watcher torn down on exit
  });

  it("re-syncs quietly on a config change without killing eve", async () => {
    const { deps, calls, emitExit, triggerChange } = makeDeps();
    const p = dev([], "/proj", deps);
    await Promise.resolve();
    triggerChange(); // simulate editing deskmate.config.ts
    await Promise.resolve();
    expect(calls).toContain("sync:quiet");
    emitExit(0);
    await p;
  });

  it("keeps eve running when a re-sync throws (invalid config saved mid-edit)", async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce(undefined) // initial ok
      .mockRejectedValueOnce(new Error("invalid config")); // edit is broken
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, emitExit, triggerChange } = makeDeps({ sync });
    const p = dev([], "/proj", deps);
    await Promise.resolve();
    triggerChange();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/invalid config/));
    emitExit(0); // eve still alive → can exit normally
    await p;
    warn.mockRestore();
  });

  it("serializes re-syncs, coalescing edits during an in-flight sync into one follow-up", async () => {
    // A sync can outlast the debounce window; two concurrent syncCommand runs would
    // interleave rm/write on agent/** and corrupt the tree. Prove only one runs at a
    // time and that N edits during an in-flight sync collapse to a single follow-up.
    const releases: Array<() => void> = [];
    let quietRuns = 0;
    const sync = vi.fn(async (_cwd: string, opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) return; // initial sync resolves immediately
      quietRuns++;
      await new Promise<void>((resolve) => releases.push(resolve)); // hang until released
    });
    // Drain all pending microtasks (the sync→catch→finally→resync chain spans several).
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));
    const { deps, emitExit, triggerChange } = makeDeps({ sync });
    const p = dev([], "/proj", deps);
    await flush(); // initial sync + spawn settle

    triggerChange(); // starts quiet re-sync #1 (in-flight/hung)
    await flush();
    triggerChange(); // in-flight → queued, must NOT start a 2nd concurrent run
    triggerChange(); // still just queued (coalesced)
    await flush();
    expect(quietRuns).toBe(1); // one running despite three edits

    releases[0]!(); // finish re-sync #1 → exactly one coalesced follow-up runs
    await flush();
    expect(quietRuns).toBe(2); // a single follow-up, not two

    releases[1]?.(); // let the follow-up finish so dev can exit cleanly
    emitExit(0);
    await p;
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
