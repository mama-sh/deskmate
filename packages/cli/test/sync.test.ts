import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCommand } from "../src/sync/index.js";

// End-to-end sync ownership: `syncCommand` must fully own each surviving deskmate's
// generated `agent/subagents/<id>/` subtree, so a tool removed from the authored
// `roles/<id>/tools/` leaves NO stale generated shim behind (a dangling shim would
// import a now-missing file and break `eve build`).
//
// The config is written as a plain `export default { … }` object (no `@deskmate/core`
// import) so the temp dir needs no installed deps; `syncCommand` only reads
// `mod.default` and passes it to the pure planner.

const CONFIG = `export default {
  model: "anthropic/claude-sonnet-5",
  frontDesk: { maxTurns: 6 },
  connections: {},
  deskmates: {
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary: "Triages incidents.",
      reads: [],
    },
  },
  channels: {},
};
`;

let cwd: string;

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("syncCommand", () => {
  it("removes a stale generated tool shim after its authored source is deleted", async () => {
    cwd = mkdtempSync(join(tmpdir(), "deskmate-sync-"));
    writeFileSync(join(cwd, "deskmate.config.ts"), CONFIG);
    mkdirSync(join(cwd, "roles/devops/tools"), { recursive: true });
    writeFileSync(join(cwd, "roles/devops/instructions.md"), "# DevOps\n");
    writeFileSync(join(cwd, "roles/devops/tools/x.ts"), "export default {};\n");

    // First sync: the tool shim is generated for the authored tool.
    await syncCommand(cwd);
    const shim = join(cwd, "agent/subagents/devops/tools/x.ts");
    expect(existsSync(shim)).toBe(true);

    // Remove the authored tool, then re-sync. The subtree is wiped + rebuilt, so the
    // now-orphaned generated shim must be gone (not linger and break `eve build`).
    rmSync(join(cwd, "roles/devops/tools/x.ts"));
    await syncCommand(cwd);
    expect(existsSync(shim)).toBe(false);

    // The deskmate itself is still fully generated (agent.ts recreated fresh).
    expect(existsSync(join(cwd, "agent/subagents/devops/agent.ts"))).toBe(true);
  });
});
