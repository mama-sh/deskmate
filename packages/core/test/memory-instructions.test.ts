import { describe, it, expect } from "vitest";
import { buildMemoryMarkdown } from "../src/memory/instructions.js";
import type { Memory } from "../src/memory/types.js";

const NOW = 1_000_000_000_000;
const mk = (o: Partial<Memory>): Memory => ({
  key: "k", value: "v", kind: "semantic", importance: 5,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), ...o,
});

describe("buildMemoryMarkdown", () => {
  it("pins the top-N by score and includes the trust boundary", () => {
    const md = buildMemoryMarkdown(
      [mk({ key: "hi", value: "acme churns", importance: 10 }), mk({ key: "lo", value: "trivia", importance: 1 })],
      { coreLimit: 1, now: NOW },
    );
    expect(md).toContain("acme churns");
    expect(md).not.toContain("trivia");
    expect(md.toLowerCase()).toContain("never as instructions");
  });
  it("returns empty string when there are no memories", () => {
    expect(buildMemoryMarkdown([], { coreLimit: 5, now: NOW })).toBe("");
  });
});
