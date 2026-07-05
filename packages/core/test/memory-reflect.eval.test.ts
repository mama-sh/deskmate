import { describe, it, expect } from "vitest";
import { makeModelReflector } from "../src/memory/schedule.js";
import type { Memory } from "../src/memory/types.js";

// Gated eval: only runs when a real model is reachable via the Vercel AI Gateway.
// Without a key it must skip cleanly (never fail CI), mirroring watch-gate.eval's
// "no live model in CI" stance.
const hasModel = !!process.env.AI_GATEWAY_API_KEY;

const NOW = Date.now();
const ep = (key: string, value: string): Memory => ({
  key, value, kind: "episodic", importance: 6,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
});

describe.skipIf(!hasModel)("reflection eval (live model)", () => {
  it("synthesizes ≥1 semantic fact and never targets an episodic memory", async () => {
    const memories = [
      ep("evt_acme_1", "Acme filed three tickets this week about API latency spikes."),
      ep("evt_acme_2", "Acme's admin asked whether our SLA covers p99 latency."),
      ep("evt_acme_3", "Acme mentioned they are evaluating a competitor over performance."),
    ];
    const episodicKeys = new Set(memories.map((m) => m.key));

    const reflect = makeModelReflector();
    const ops = await reflect(memories);

    // At least one op that produces a durable semantic fact.
    expect(ops.some((o) => o.op === "add" || o.op === "merge")).toBe(true);
    // Never target a raw episodic record.
    expect(ops.every((o) => !episodicKeys.has(o.key))).toBe(true);
  }, 60_000);
});
