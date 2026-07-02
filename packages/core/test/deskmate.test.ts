import { describe, it, expect } from "vitest";
import { defineTeam } from "../src/config.js";
import { deskmateAgentConfig } from "../src/deskmate.js"; // pure helper under defineDeskmate

const team = defineTeam({
  model: "anthropic/claude-opus-4.8",
  deskmates: {
    devops: { role: "devops", emoji: "🔧", displayName: "DevOps Engineer",
              summary: "Triages incidents; proposes fixes.", reads: [] },
  },
  connections: {},
});

describe("deskmateAgentConfig", () => {
  it("builds a routing description from summary and falls back to team model", () => {
    const cfg = deskmateAgentConfig(team, "devops");
    expect(cfg.model).toBe("anthropic/claude-opus-4.8");
    expect(cfg.description).toMatch(/DevOps Engineer/);
    expect(cfg.description).toMatch(/Triages incidents/);
  });
  it("throws on unknown id", () => {
    expect(() => deskmateAgentConfig(team, "ghost")).toThrow(/unknown deskmate/i);
  });
});
