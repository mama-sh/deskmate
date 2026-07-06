import { describe, it, expect, vi } from "vitest";
import { deploy, runCommand, type DeployDeps } from "../src/deploy.js";

function makeDeps(runCodes: number[] = [0, 0]) {
  const calls: string[] = [];
  const queue = [...runCodes];
  const deps: DeployDeps = {
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
