import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";

describe("defineTeam", () => {
  it("applies defaults (maxTurns 6) and returns a normalized team", () => {
    const team = defineTeam({
      deskmates: { devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer", summary: "…", reads: ["github"] } },
      connections: { github: { kind: "mcp", env: "GITHUB", repo: "acme/app" } },
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
});
