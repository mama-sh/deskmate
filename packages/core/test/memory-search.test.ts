import { describe, it, expect } from "vitest";
import { searchMemories } from "../src/memory/tools.js";
import type { Memory } from "../src/memory/types.js";

const NOW = 1_000_000_000_000;
const mk = (over: Partial<Memory>): Memory => ({
  key: "k", value: "v", kind: "semantic", importance: 5,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...over,
});

describe("searchMemories", () => {
  it("with no query, returns the pool capped to limit", () => {
    const pool = [mk({ key: "a" }), mk({ key: "b" }), mk({ key: "c" })];
    const out = searchMemories(pool, undefined, 2);
    expect(out.map((m) => m.key)).toEqual(["a", "b"]);
  });

  it("finds a match that is NOT in the first `limit` items (full-pool search)", () => {
    // 25 filler memories, then the real match at the end — a top-`limit` search would miss it.
    const filler = Array.from({ length: 25 }, (_, i) => mk({ key: `filler_${i}`, value: "nope" }));
    const pool = [...filler, mk({ key: "target", value: "the special needle" })];
    const out = searchMemories(pool, "needle", 5);
    expect(out.map((m) => m.key)).toEqual(["target"]);
  });

  it("matches on both key and value", () => {
    const pool = [
      mk({ key: "prefers_dark_mode", value: "unrelated" }),
      mk({ key: "unrelated", value: "the user likes DARK chocolate" }),
    ];
    expect(searchMemories(pool, "dark", 10).map((m) => m.key).sort()).toEqual([
      "prefers_dark_mode",
      "unrelated",
    ]);
  });

  it("caps the result to `limit`", () => {
    const pool = Array.from({ length: 10 }, (_, i) => mk({ key: `m_${i}`, value: "matchme" }));
    expect(searchMemories(pool, "matchme", 3)).toHaveLength(3);
  });
});
