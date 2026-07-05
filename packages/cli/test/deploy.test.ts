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
  it("runs sync → vercel build (experimental) → patch → vercel deploy --prebuilt, in order", async () => {
    const { deps, calls } = makeDeps([0, 0]);
    const code = await deploy(["--yes"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "sync",
      "run:vercel build --prod --yes [xfw]", // passthrough args reach the build too
      "patch",
      "run:vercel deploy --prebuilt --prod --yes",
    ]);
  });

  it("short-circuits (no patch, no deploy) when the build fails", async () => {
    const { deps, calls } = makeDeps([2]); // build exits non-zero
    const code = await deploy([], "/proj", deps);
    expect(code).toBe(2);
    expect(calls).toEqual(["sync", "run:vercel build --prod [xfw]"]);
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
