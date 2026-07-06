import { describe, it, expect, vi } from "vitest";
import type { TeamConfig } from "@deskmate/core";
import { deploy, runCommand, type DeployDeps } from "../src/deploy.js";

function makeDeps(runCodes: number[] = [0, 0], opts: { coding?: boolean; channel?: boolean } = {}) {
  const calls: string[] = [];
  const queue = [...runCodes];
  // loadTeam is a read (not an ordered side effect), so it does NOT push to `calls` —
  // the existing sequence assertions stay valid for a non-sandbox team.
  const team = {
    deskmates: opts.coding ? { engineer: { coding: { repos: [] } } } : { devops: {} },
    github: opts.channel ? { org: "acme", channel: true } : undefined,
  } as unknown as TeamConfig;
  const deps: DeployDeps = {
    loadTeam: vi.fn(async () => team),
    sync: vi.fn(async () => {
      calls.push("sync");
    }),
    run: vi.fn(async (cmd, args, _cwd, env) => {
      const envNote = env?.VERCEL_USE_EXPERIMENTAL_FRAMEWORKS ? " [xfw]" : "";
      calls.push(`run:${cmd} ${args.join(" ")}${envNote}`);
      return queue.shift() ?? 0;
    }),
    patch: vi.fn(() => {
      calls.push("patch");
      return ["/out/__server.func"];
    }),
  };
  return { deps, calls };
}

describe("deploy", () => {
  it("runs pull → sync → vercel build (experimental) → patch → vercel deploy --prebuilt, in order", async () => {
    const { deps, calls } = makeDeps([0, 0, 0]);
    const code = await deploy(["--yes"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      // pull the prod env first (experimental frameworks); passthrough args reach it too
      "run:vercel pull --yes --environment=production --yes [xfw]",
      "sync",
      "run:vercel build --prod --yes [xfw]", // passthrough args reach the build too
      "patch",
      "run:vercel deploy --prebuilt --prod --yes",
    ]);
  });

  it("coding team: provisions via a SOURCE vercel deploy after sync, before the local build", async () => {
    const { deps, calls } = makeDeps([0, 0, 0, 0], { coding: true }); // pull, provision, build, deploy
    const code = await deploy(["--yes"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "run:vercel pull --yes --environment=production --yes [xfw]",
      "sync",
      "run:vercel deploy --yes [xfw]", // SOURCE provisioning: no --prebuilt, no --prod
      "run:vercel build --prod --yes [xfw]",
      "patch",
      "run:vercel deploy --prebuilt --prod --yes",
    ]);
  });

  it("github-channel-only team (no coding deskmate): also provisions + reminds", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    const { deps, calls } = makeDeps([0, 0, 0, 0], { channel: true }); // pull, provision, build, deploy
    const code = await deploy([], "/proj", deps);
    spy.mockRestore();
    expect(code).toBe(0);
    expect(calls).toContain("run:vercel deploy [xfw]"); // source provisioning still runs
    expect(logs.join("\n")).toMatch(/GITHUB_APP_ID/);
  });

  it("coding team: strips --prod/--target/--prebuilt from the SOURCE provision deploy", async () => {
    const { deps, calls } = makeDeps([0, 0, 0, 0], { coding: true });
    await deploy(["--prod", "--yes", "--target", "production"], "/proj", deps);
    // the provision (first `vercel deploy` without --prebuilt) must not carry target flags —
    // else it would ship the un-patched build to prod. Only --yes survives.
    const provision = calls.find((c) => c.startsWith("run:vercel deploy") && !c.includes("--prebuilt"));
    expect(provision).toBe("run:vercel deploy --yes [xfw]");
  });

  it("coding team: preserves -t <token> (Vercel's --token shorthand) in the provision deploy", async () => {
    const { deps, calls } = makeDeps([0, 0, 0, 0], { coding: true });
    await deploy(["-t", "sekret", "--yes"], "/proj", deps);
    const provision = calls.find((c) => c.startsWith("run:vercel deploy") && !c.includes("--prebuilt"));
    expect(provision).toBe("run:vercel deploy -t sekret --yes [xfw]"); // -t is auth, not a target flag
  });

  it("coding team: a failed final deploy returns non-zero and prints no reminder", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    const { deps } = makeDeps([0, 0, 0, 9], { coding: true }); // pull, provision, build ok; final deploy=9
    const code = await deploy([], "/proj", deps);
    spy.mockRestore();
    expect(code).toBe(9);
    expect(logs.join("\n")).not.toMatch(/GITHUB_APP_ID/);
  });

  it("coding team: a failed provisioning deploy short-circuits (no build, no patch, no prebuilt deploy)", async () => {
    const { deps, calls } = makeDeps([0, 5], { coding: true }); // pull ok, provision exits 5
    const code = await deploy([], "/proj", deps);
    expect(code).toBe(5);
    expect(calls).toEqual([
      "run:vercel pull --yes --environment=production [xfw]",
      "sync",
      "run:vercel deploy [xfw]",
    ]);
    expect(deps.patch).not.toHaveBeenCalled();
  });

  it("coding team: prints the GitHub App env reminder after a successful deploy", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    const { deps } = makeDeps([0, 0, 0, 0], { coding: true });
    await deploy([], "/proj", deps);
    spy.mockRestore();
    expect(logs.join("\n")).toMatch(/GITHUB_APP_ID/);
  });

  it("non-coding team: does NOT print the GitHub App reminder", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    const { deps } = makeDeps([0, 0, 0]);
    await deploy([], "/proj", deps);
    spy.mockRestore();
    expect(logs.join("\n")).not.toMatch(/GITHUB_APP_ID/);
  });

  it("short-circuits (no patch, no deploy) when the build fails", async () => {
    const { deps, calls } = makeDeps([0, 2]); // pull ok, build exits non-zero
    const code = await deploy([], "/proj", deps);
    expect(code).toBe(2);
    expect(calls).toEqual([
      "run:vercel pull --yes --environment=production [xfw]",
      "sync",
      "run:vercel build --prod [xfw]",
    ]);
    expect(deps.patch).not.toHaveBeenCalled();
  });

  it("fail-fast: returns the pull's code and runs nothing else when the env pull fails", async () => {
    const { deps, calls } = makeDeps([3]); // pull exits non-zero
    const code = await deploy([], "/proj", deps);
    expect(code).toBe(3);
    expect(calls).toEqual(["run:vercel pull --yes --environment=production [xfw]"]);
    expect(deps.sync).not.toHaveBeenCalled();
    expect(deps.patch).not.toHaveBeenCalled();
  });
});

describe("runCommand", () => {
  it("resolves non-zero (never hangs) when the command can't be spawned", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runCommand("deskmate-no-such-binary-zzz", [], process.cwd());
    expect(code).not.toBe(0);
    vi.restoreAllMocks();
  });
});
