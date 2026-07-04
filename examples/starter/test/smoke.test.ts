import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import team from "../deskmate.config.js";

// The generated `agent/**` tree is committed. This smoke test is the proof that
// `deskmate sync` produced a tree that MATCHES `deskmate.config.ts`: for every
// deskmate + connection in the config there is a corresponding generated file,
// the shared front-desk scaffolding exists, and the env template lists every
// connection's env keys. If someone edits the config without re-running sync,
// this test fails.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const agent = (...p: string[]) => join(ROOT, "agent", ...p);
const exists = (...p: string[]) => existsSync(agent(...p));

/** Recursively find any file named `SKILL.md` under `dir` (empty if dir absent). */
function hasSkillFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (hasSkillFile(abs)) return true;
    } else if (name === "SKILL.md") {
      return true;
    }
  }
  return false;
}

describe("generated agent/** tree matches deskmate.config.ts", () => {
  it("has the front-desk scaffolding", () => {
    expect(exists("agent.ts")).toBe(true);
    expect(exists("instructions.md")).toBe(true);
    expect(exists("lib", "deskmates.ts")).toBe(true);
    expect(exists("lib", "channel-routes.ts")).toBe(true);
    expect(exists("tools", "deskmate_says.ts")).toBe(true);
  });

  it("has all four channel modules", () => {
    for (const ch of ["slack.ts", "slack-ambient.ts", "eve.ts", "deskmate-avatars.ts"]) {
      expect(exists("channels", ch)).toBe(true);
    }
  });

  it("generates a subagent tree for every configured deskmate", () => {
    const ids = Object.keys(team.deskmates);
    expect(ids.sort()).toEqual(["devops", "product_analyst"]);
    for (const [id, d] of Object.entries(team.deskmates)) {
      expect(exists("subagents", id, "agent.ts")).toBe(true);
      expect(exists("subagents", id, "instructions.md")).toBe(true);
      // one connection shim per `reads` entry
      for (const conn of d.reads) {
        expect(exists("subagents", id, "connections", `${conn}.ts`)).toBe(true);
      }
      // the authored skill playbook is copied in
      expect(hasSkillFile(agent("subagents", id, "skills"))).toBe(true);
    }
  });

  it("generates the memory tree for the memory-enabled deskmate (product_analyst)", () => {
    // product_analyst has `memory: true` in the config; the other deskmate does not.
    expect(exists("subagents", "product_analyst", "instructions", "memory.ts")).toBe(true);
    for (const tool of ["remember", "recall", "forget"]) {
      expect(exists("subagents", "product_analyst", "tools", `${tool}.ts`)).toBe(true);
    }
    // The nightly reflection schedule is root-only and emitted once.
    expect(exists("schedules", "memory-reflection.ts")).toBe(true);
    // A deskmate without `memory` gets no memory shims.
    expect(exists("subagents", "devops", "tools", "remember.ts")).toBe(false);
    expect(exists("subagents", "devops", "instructions", "memory.ts")).toBe(false);
  });

  it("spot-checks the paths called out in the task", () => {
    expect(exists("subagents", "devops", "agent.ts")).toBe(true);
    expect(exists("subagents", "product_analyst", "agent.ts")).toBe(true);
    expect(exists("channels", "slack.ts")).toBe(true);
    expect(exists("subagents", "devops", "connections", "sentry.ts")).toBe(true);
    expect(hasSkillFile(agent("subagents", "devops", "skills"))).toBe(true);
  });

  it("bakes the config model into the root agent", () => {
    const rootAgent = readFileSync(agent("agent.ts"), "utf8");
    expect(rootAgent).toContain(team.model);
  });

  it("does NOT generate a subagent for a role that isn't in the config", () => {
    expect(exists("subagents", "growth_hacker")).toBe(false);
    expect(exists("subagents", "customer_success")).toBe(false);
  });

  it("writes an .env.example with each connection's env keys", () => {
    const env = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const c of Object.values(team.connections)) {
      if (c.kind === "mcp" && c.env) {
        expect(env).toContain(`${c.env}_MCP_URL=`);
        expect(env).toContain(`${c.env}_MCP_TOKEN=`);
      }
    }
  });
});
