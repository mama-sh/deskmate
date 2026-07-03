import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TeamConfig } from "@deskmate/core";
import { planSync } from "../src/sync/plan.js";

// A fixture consumer tree: authored roles/ + a shared connections/ + a stale
// (ghost) generated subagent dir. planSync reads this and returns the writes/deletes
// that would rebuild agent/**.
const DEVOPS_INSTRUCTIONS = "# Role: DevOps\nAuthored, verbatim.\n";
const SKILL_MD = "# logging-observability\nTop-level skill playbook.\n";
const SKILL_REF = "# Alerting patterns\nA nested reference file.\n";

const fixtureTeam = {
  model: "anthropic/claude-opus-4.6",
  frontDesk: { maxTurns: 6 },
  connections: {
    sentry: { kind: "mcp", env: "SENTRY" },
    mixpanel: { kind: "mcp", env: "MIXPANEL" },
    orphan: { kind: "mcp", env: "ORPHAN" },
  },
  deskmates: {
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary: "Triages incidents.",
      reads: ["sentry", "orphan"],
    },
    product_analyst: {
      role: "product_analyst",
      emoji: ":bar_chart:",
      displayName: "Product Analyst",
      summary: "Turns usage data into a narrative.",
      reads: ["mixpanel"],
    },
  },
  channels: {},
} as unknown as TeamConfig;

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "deskmate-plan-"));
  // Authored devops role: instructions + a tool + a deskmate-local connection.
  mkdirSync(join(cwd, "roles/devops/tools"), { recursive: true });
  mkdirSync(join(cwd, "roles/devops/connections"), { recursive: true });
  writeFileSync(join(cwd, "roles/devops/instructions.md"), DEVOPS_INSTRUCTIONS);
  writeFileSync(join(cwd, "roles/devops/tools/x.ts"), "export default {};\n");
  writeFileSync(join(cwd, "roles/devops/connections/sentry.ts"), "export default {};\n");
  // A skill playbook with a nested references/ file — copied verbatim, structure preserved.
  mkdirSync(join(cwd, "roles/devops/skills/logging-observability/references"), { recursive: true });
  writeFileSync(join(cwd, "roles/devops/skills/logging-observability/SKILL.md"), SKILL_MD);
  writeFileSync(
    join(cwd, "roles/devops/skills/logging-observability/references/alerting-patterns.md"),
    SKILL_REF,
  );
  // Authored product_analyst role: instructions only (its connection is SHARED).
  mkdirSync(join(cwd, "roles/product_analyst"), { recursive: true });
  writeFileSync(join(cwd, "roles/product_analyst/instructions.md"), "# Analyst\n");
  // A shared, repo-root connection (resolution fallback #2).
  mkdirSync(join(cwd, "connections"), { recursive: true });
  writeFileSync(join(cwd, "connections/mixpanel.ts"), "export default {};\n");
  // A stale generated subagent dir for a deskmate no longer in the config.
  mkdirSync(join(cwd, "agent/subagents/ghost"), { recursive: true });
  writeFileSync(join(cwd, "agent/subagents/ghost/agent.ts"), "export default {};\n");
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function paths(plan: { writes: { path: string }[] }): string[] {
  return plan.writes.map((w) => w.path);
}
function find(plan: { writes: { path: string; contents: string }[] }, rel: string) {
  return plan.writes.find((w) => w.path === join(cwd, rel));
}

describe("planSync", () => {
  it("plans every root file", () => {
    const plan = planSync(fixtureTeam, cwd);
    const ps = paths(plan);
    for (const rel of [
      "agent/agent.ts",
      "agent/instructions.md",
      "agent/lib/deskmates.ts",
      "agent/tools/deskmate_says.ts",
      "agent/channels/slack.ts",
      "agent/channels/slack-ambient.ts",
      "agent/channels/eve.ts",
      "agent/channels/deskmate-avatars.ts",
      ".env.example",
    ]) {
      expect(ps).toContain(join(cwd, rel));
    }
  });

  it("plans each deskmate's subagent files", () => {
    const plan = planSync(fixtureTeam, cwd);
    const ps = paths(plan);
    for (const rel of [
      "agent/subagents/devops/agent.ts",
      "agent/subagents/devops/instructions.md",
      "agent/subagents/devops/tools/x.ts",
      "agent/subagents/devops/connections/sentry.ts",
      "agent/subagents/devops/connections/orphan.ts",
      "agent/subagents/product_analyst/agent.ts",
      "agent/subagents/product_analyst/instructions.md",
      "agent/subagents/product_analyst/connections/mixpanel.ts",
    ]) {
      expect(ps).toContain(join(cwd, rel));
    }
  });

  it("copies subagent instructions.md byte-for-byte from the authored role", () => {
    const plan = planSync(fixtureTeam, cwd);
    const authored = readFileSync(join(cwd, "roles/devops/instructions.md"), "utf8");
    const write = find(plan, "agent/subagents/devops/instructions.md");
    expect(write?.contents).toBe(authored);
    expect(write?.contents).toBe(DEVOPS_INSTRUCTIONS);
  });

  it("copies the deskmate's skills tree verbatim, preserving nested dirs", () => {
    const plan = planSync(fixtureTeam, cwd);
    const skill = find(plan, "agent/subagents/devops/skills/logging-observability/SKILL.md");
    const ref = find(
      plan,
      "agent/subagents/devops/skills/logging-observability/references/alerting-patterns.md",
    );
    expect(skill?.contents).toBe(SKILL_MD);
    expect(ref?.contents).toBe(SKILL_REF);
    // Copied verbatim: no GENERATED banner injected into skill assets.
    expect(skill?.contents).not.toContain("GENERATED by");
  });

  it("resolves a connection shim to the deskmate-local authored file first", () => {
    const plan = planSync(fixtureTeam, cwd);
    const write = find(plan, "agent/subagents/devops/connections/sentry.ts");
    expect(write?.contents).toContain('from "../../../../roles/devops/connections/sentry.js"');
  });

  it("falls back to a shared repo-root connection when no local file exists", () => {
    const plan = planSync(fixtureTeam, cwd);
    const write = find(plan, "agent/subagents/product_analyst/connections/mixpanel.ts");
    expect(write?.contents).toContain('from "../../../../connections/mixpanel.js"');
  });

  it("emits a TODO stub when no authored connection file exists anywhere", () => {
    const plan = planSync(fixtureTeam, cwd);
    const write = find(plan, "agent/subagents/devops/connections/orphan.ts");
    expect(write?.contents).toContain("TODO(deskmate sync)");
    expect(write?.contents).toContain("ORPHAN_MCP_URL");
  });

  it("plans deletion of ghost subagent dirs not in the config", () => {
    const plan = planSync(fixtureTeam, cwd);
    expect(plan.deletes).toContain(join(cwd, "agent/subagents/ghost"));
    // Deskmates present in the config are NOT deleted.
    expect(plan.deletes).not.toContain(join(cwd, "agent/subagents/devops"));
  });

  it("is idempotent: same inputs → identical writes + deletes", () => {
    const a = planSync(fixtureTeam, cwd);
    const b = planSync(fixtureTeam, cwd);
    expect(b.writes).toEqual(a.writes);
    expect(b.deletes).toEqual(a.deletes);
  });
});
