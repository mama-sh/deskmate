import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";

describe("defineTeam", () => {
  it("applies defaults (maxTurns 6) and returns a normalized team", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer", summary: "…", reads: ["github"] } },
      connections: { github: { kind: "mcp", env: "GITHUB" } },
    });
    expect(team.frontDesk.maxTurns).toBe(6);
    expect(team.deskmates.devops.reads).toEqual(["github"]);
    expect(Object.keys(team.connections)).toContain("github");
  });

  it("rejects a deskmate whose `reads` names an unknown connection", () => {
    expect(() =>
      defineTeam({
        deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["nope"] } },
        connections: {},
      }),
    ).toThrow(/unknown connection/i);
  });

  it("rejects a channel route pointing at an unknown deskmate", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: {},
        channels: { C1: { deskmate: "ghost" } },
      }),
    ).toThrow(/unknown deskmate/i);
  });

  it("rejects a deskmate id that isn't a snake_case identifier", () => {
    expect(() =>
      defineTeam({
        deskmates: { "Bad-Id": { role: "x", emoji: "x", displayName: "x", summary: "…", reads: [] } },
        connections: {},
      }),
    ).toThrow(/snake_case/i);
  });

  it("rejects a deskmate `role` that isn't a snake_case identifier (path-traversal guard)", () => {
    expect(() =>
      defineTeam({
        deskmates: { devops: { role: "../evil", emoji: "🔧", displayName: "D", summary: "…", reads: [] } },
        connections: {},
      }),
    ).toThrow(/snake_case/i);
  });

  it("rejects a connection name that isn't a snake_case identifier", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { "Bad-Name": { kind: "mcp" } },
      }),
    ).toThrow(/snake_case/i);
  });

  it("allows uppercase Slack channel ids as channel keys (not identifier-guarded)", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: [] } },
      connections: {},
      channels: { C0INCIDENTS: { deskmate: "devops", lock: true } },
    });
    expect(team.channels.C0INCIDENTS).toEqual({ deskmate: "devops", lock: true });
  });

  it("accepts an optional per-deskmate voice line", () => {
    const team = defineTeam({
      deskmates: {
        devops: {
          role: "devops",
          emoji: ":wrench:",
          displayName: "DevOps Engineer",
          summary: "Triages incidents.",
          voice: "Terse SRE. Leads with the punchline.",
        },
      },
    });
    expect(team.deskmates.devops.voice).toBe("Terse SRE. Leads with the punchline.");
  });

  it("leaves voice undefined when omitted", () => {
    const team = defineTeam({
      deskmates: {
        devops: { role: "devops", emoji: ":wrench:", displayName: "DevOps", summary: "x" },
      },
    });
    expect(team.deskmates.devops.voice).toBeUndefined();
  });

  it("parses a channel watch block with defaults", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
      channels: { C0INC: { deskmate: "devops", watch: {} } },
    });
    expect(team.channels.C0INC.watch).toMatchObject({ react: true, reply: true, post: false, approvePosts: false, picker: "routed" });
  });

  it("rejects an unknown picker", () => {
    expect(() => defineTeam({
      deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
      channels: { C0INC: { deskmate: "devops", watch: { picker: "nope" } } },
    })).toThrow();
  });

  it("accepts an oauth connection with connect + service", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "D", summary: "…", reads: ["vercel"] } },
      connections: { vercel: { kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" } },
    });
    expect(team.connections.vercel).toMatchObject({ kind: "mcp", connect: "vercel/deskmate", service: "mcp.vercel.com" });
  });

  it("rejects a connection that sets both env (token) and connect (oauth)", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { bad: { kind: "mcp", env: "BAD", connect: "bad/deskmate" } },
      }),
    ).toThrow(/either .*env.* or .*connect/i);
  });

  it("rejects `service` without `connect`", () => {
    expect(() =>
      defineTeam({
        deskmates: {},
        connections: { bad: { kind: "mcp", env: "BAD", service: "mcp.bad.com" } },
      }),
    ).toThrow(/service.*only.*connect/i);
  });
});
