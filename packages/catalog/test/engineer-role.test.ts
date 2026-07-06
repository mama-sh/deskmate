import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROLE = fileURLToPath(new URL("../roles/engineer/", import.meta.url));

describe("engineer role", () => {
  it("has a well-formed deskmate.json", () => {
    const meta = JSON.parse(readFileSync(join(ROLE, "deskmate.json"), "utf8"));
    expect(meta.id).toBe("engineer");
    expect(meta.displayName).toBe("Software Engineer");
    expect(typeof meta.emoji).toBe("string");
    expect(typeof meta.summary).toBe("string");
    // github is the App/coding capability, not an MCP read — no scaffolded providers.
    expect(meta.providers ?? []).toEqual([]);
  });

  it("ships agent.ts, instructions.md, and the agentic-coding skill", () => {
    expect(existsSync(join(ROLE, "agent.ts"))).toBe(true);
    expect(existsSync(join(ROLE, "instructions.md"))).toBe(true);
    expect(existsSync(join(ROLE, "skills/agentic-coding/SKILL.md"))).toBe(true);
  });

  it("agent description routes coding work and forbids merging", () => {
    const agent = readFileSync(join(ROLE, "agent.ts"), "utf8");
    expect(agent).toMatch(/pull request/i);
    expect(agent).toMatch(/never merge/i);
  });
});
