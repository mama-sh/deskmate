import { describe, it, expect, vi } from "vitest";
import { connectCommand, type ConnectDeps } from "../src/connect.js";

function makeDeps(connections: Record<string, unknown>, runCodes: number[] = []) {
  const calls: string[] = [];
  const queue = [...runCodes];
  const deps: ConnectDeps = {
    loadConnections: vi.fn(async () => connections as any),
    run: vi.fn(async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return queue.shift() ?? 0;
    }),
  };
  return { deps, calls };
}

describe("connectCommand", () => {
  it("runs vercel connect create → attach → env pull for an oauth connection", async () => {
    const { deps, calls } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } });
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls).toEqual([
      "vercel connect create mcp.vercel.com --name deskmate",
      "vercel connect attach vercel/deskmate --yes",
      "vercel env pull",
    ]);
  });

  it("tolerates a non-zero `create` (connector may already exist) but still attaches", async () => {
    const { deps, calls } = makeDeps(
      { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
      [1, 0, 0],
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls[1]).toBe("vercel connect attach vercel/deskmate --yes");
    vi.restoreAllMocks();
  });

  it("returns the attach exit code when attach fails", async () => {
    const { deps } = makeDeps(
      { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
      [0, 3],
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(3);
    vi.restoreAllMocks();
  });

  it("accepts a service passed as a positional arg when config omits it", async () => {
    const { deps, calls } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate" } });
    const code = await connectCommand(["vercel", "mcp.vercel.com"], "/proj", deps);
    expect(code).toBe(0);
    expect(calls[0]).toBe("vercel connect create mcp.vercel.com --name deskmate");
  });

  it("errors when the connection is not oauth", async () => {
    const { deps } = makeDeps({ sentry: { kind: "mcp", env: "SENTRY" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["sentry"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });

  it("errors when the connection is unknown", async () => {
    const { deps } = makeDeps({});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["ghost"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });

  it("errors when no service is available (config + arg both missing)", async () => {
    const { deps } = makeDeps({ vercel: { kind: "mcp", connect: "vercel/deskmate" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await connectCommand(["vercel"], "/proj", deps);
    expect(code).toBe(1);
    vi.restoreAllMocks();
  });
});
