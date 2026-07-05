import { describe, it, expect } from "vitest";
import { applyPut } from "../src/memory/apply.js";
import type { Memory } from "../src/memory/types.js";

const NOW = 1_000_000_000_000;
const mk = (over: Partial<Memory>): Memory => ({
  key: "k", value: "v", kind: "semantic", importance: 5,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...over,
});

describe("applyPut", () => {
  it("adds a new memory with clock timestamps and defaults", () => {
    const out = applyPut([], { key: "a", value: "hi" }, { maxItems: 10, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "a", value: "hi", kind: "semantic", importance: 5 });
    expect(out[0].updatedAt).toBe(new Date(NOW).toISOString());
  });
  it("overwrites by key (dedupe/consolidation), keeping createdAt", () => {
    const items = [mk({ key: "a", value: "old", createdAt: new Date(NOW - 5000).toISOString() })];
    const out = applyPut(items, { key: "a", value: "new" }, { maxItems: 10, now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe("new");
    expect(out[0].createdAt).toBe(new Date(NOW - 5000).toISOString());
    expect(out[0].updatedAt).toBe(new Date(NOW).toISOString());
  });
  it("evicts the lowest-scored memory when over maxItems (forgetting)", () => {
    const keep = mk({ key: "keep", importance: 9 });
    const drop = mk({ key: "drop", importance: 1 });
    const out = applyPut([keep, drop], { key: "c", value: "v", importance: 5 }, { maxItems: 2, now: NOW });
    expect(out.map((m) => m.key).sort()).toEqual(["c", "keep"]);
  });
  it("always retains the just-written memory even when it is the lowest-scored", () => {
    // Full pool (maxItems: 1) holding one high-importance item; write a NEW low-importance key.
    const existing = mk({ key: "hi", importance: 10 });
    const out = applyPut([existing], { key: "new_low", value: "v", importance: 1 }, { maxItems: 1, now: NOW });
    expect(out.map((m) => m.key)).toEqual(["new_low"]); // the new key is retained, the old one evicted
  });
});
