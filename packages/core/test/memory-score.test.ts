import { describe, it, expect } from "vitest";
import { scoreMemory, pinCore } from "../src/memory/score.js";
import type { Memory } from "../src/memory/types.js";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;
const mk = (o: Partial<Memory>): Memory => ({
  key: "k", value: "v", kind: "semantic", importance: 5,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...o,
});

describe("scoreMemory", () => {
  it("ranks higher importance above lower at equal recency", () => {
    expect(scoreMemory(mk({ importance: 9 }), NOW)).toBeGreaterThan(scoreMemory(mk({ importance: 2 }), NOW));
  });
  it("decays with age (recency)", () => {
    const fresh = mk({ updatedAt: new Date(NOW).toISOString() });
    const stale = mk({ updatedAt: new Date(NOW - 30 * DAY).toISOString() });
    expect(scoreMemory(fresh, NOW)).toBeGreaterThan(scoreMemory(stale, NOW));
  });
});

describe("pinCore", () => {
  it("returns the top-N by score, highest first", () => {
    const items = [mk({ key: "lo", importance: 1 }), mk({ key: "hi", importance: 10 }), mk({ key: "mid", importance: 5 })];
    expect(pinCore(items, 2, NOW).map((m) => m.key)).toEqual(["hi", "mid"]);
  });
});
