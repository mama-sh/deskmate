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
// A binary skill asset with bytes that are NOT valid UTF-8 (0xff, a lone 0x00),
// to prove skill files are copied byte-for-byte rather than UTF-8 decoded.
const SKILL_BINARY = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10]);

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
  // A binary asset (e.g. a diagram) with non-UTF8 bytes.
  writeFileSync(join(cwd, "roles/devops/skills/logging-observability/diagram.png"), SKILL_BINARY);
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
function find(plan: { writes: { path: string; contents: string | Buffer }[] }, rel: string) {
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
      "agent/lib/channel-routes.ts",
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

  it("generates agent/lib/channel-routes.ts from team.channels", () => {
    const teamWithChannels = {
      ...fixtureTeam,
      channels: { C1: { deskmate: "devops", lock: true } },
    } as unknown as TeamConfig;
    const plan = planSync(teamWithChannels, cwd);
    const write = find(plan, "agent/lib/channel-routes.ts");
    expect(write).toBeDefined();
    expect(write?.contents).toContain("export const CHANNEL_ROUTES: Record<string, ChannelRoute> = {");
    expect(write?.contents).toContain('"C1": {"deskmate":"devops","lock":true}');
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

  it("composes subagent instructions from the authored role + the house style", () => {
    const plan = planSync(fixtureTeam, cwd);
    const authored = readFileSync(join(cwd, "roles/devops/instructions.md"), "utf8");
    const write = find(plan, "agent/subagents/devops/instructions.md");
    const text = write?.contents?.toString() ?? "";
    // Authored role prose is preserved and comes first…
    expect(text.startsWith(authored.trimEnd())).toBe(true);
    // …then core's shared house-style block is appended.
    expect(text).toContain("## How you write");
    expect(text).toContain("## Grounding and clarifying");
  });

  it("copies the deskmate's skills tree verbatim, preserving nested dirs", () => {
    const plan = planSync(fixtureTeam, cwd);
    const skill = find(plan, "agent/subagents/devops/skills/logging-observability/SKILL.md");
    const ref = find(
      plan,
      "agent/subagents/devops/skills/logging-observability/references/alerting-patterns.md",
    );
    // Skill files are copied as Buffers (byte-exact); text still round-trips verbatim.
    expect(Buffer.isBuffer(skill?.contents)).toBe(true);
    expect((skill?.contents as Buffer).toString("utf8")).toBe(SKILL_MD);
    expect((ref?.contents as Buffer).toString("utf8")).toBe(SKILL_REF);
    // Copied verbatim: no GENERATED banner injected into skill assets.
    expect((skill?.contents as Buffer).toString("utf8")).not.toContain("GENERATED by");
  });

  it("copies a binary skill asset byte-for-byte (no UTF-8 mangling)", () => {
    const plan = planSync(fixtureTeam, cwd);
    const png = find(plan, "agent/subagents/devops/skills/logging-observability/diagram.png");
    expect(png).toBeDefined();
    expect(Buffer.isBuffer(png?.contents)).toBe(true);
    const bytes = png?.contents as Buffer;
    // Byte-identical to the source — and NOT what a lossy UTF-8 round-trip produces.
    expect(Buffer.compare(bytes, SKILL_BINARY)).toBe(0);
    expect(bytes.equals(SKILL_BINARY)).toBe(true);
    expect(Buffer.from(SKILL_BINARY.toString("utf8"), "utf8").equals(SKILL_BINARY)).toBe(false);
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

  it("reads authored files from roles/<d.role> when the deskmate id differs from its role", () => {
    // `ops` maps to the authored `roles/devops/` tree (id != role). The generated
    // OUTPUT stays keyed by the id (`agent/subagents/ops/…`); the SOURCE resolves
    // under roles/devops, so nothing falls back to a stub/placeholder.
    const team = {
      ...fixtureTeam,
      deskmates: {
        ops: {
          role: "devops",
          emoji: ":wrench:",
          displayName: "Ops",
          summary: "Aliased devops.",
          reads: ["sentry"],
        },
      },
    } as unknown as TeamConfig;
    const plan = planSync(team, cwd);

    // instructions.md — authored roles/devops prose (NOT the TODO placeholder),
    // composed with the shared house style.
    const instr = find(plan, "agent/subagents/ops/instructions.md");
    const instrText = instr?.contents?.toString() ?? "";
    expect(instrText.startsWith(DEVOPS_INSTRUCTIONS.trimEnd())).toBe(true);
    expect(instrText).toContain("## How you write");
    expect(instrText).not.toContain("TODO");

    // tool + connection shims target roles/devops (the role), under the ops subtree.
    const tool = find(plan, "agent/subagents/ops/tools/x.ts");
    expect(tool?.contents).toContain('from "../../../../roles/devops/tools/x.js"');
    const conn = find(plan, "agent/subagents/ops/connections/sentry.ts");
    expect(conn?.contents).toContain('from "../../../../roles/devops/connections/sentry.js"');

    // skills copied from roles/devops, keyed under the ops subtree (Buffer, byte-exact).
    const skill = find(plan, "agent/subagents/ops/skills/logging-observability/SKILL.md");
    expect((skill?.contents as Buffer).toString("utf8")).toBe(SKILL_MD);
  });
});
