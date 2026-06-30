import { describe, it, expect } from "vitest";
import { recordDecision } from "../library/deskmates/devops/tools/record_decision.js";

describe("recordDecision", () => {
  it("returns a normalized record with a trimmed title", () => {
    const r = recordDecision({ title: "  Roll back deploy abc123  ", detail: "spiked errors" });
    expect(r).toMatchObject({ recorded: true, title: "Roll back deploy abc123", detail: "spiked errors" });
    expect(typeof r.id).toBe("string");
    expect(r.id.length).toBeGreaterThan(0);
  });

  it("rejects an empty title", () => {
    expect(() => recordDecision({ title: "   ", detail: "x" })).toThrow(/title/i);
  });
});
