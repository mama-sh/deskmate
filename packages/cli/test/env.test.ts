import { describe, it, expect } from "vitest";
import { escapeRegExp } from "../src/lib/env.js";

describe("escapeRegExp", () => {
  it("escapes every RegExp metacharacter so it matches literally", () => {
    const raw = ".*+?^${}()|[]\\";
    const re = new RegExp(escapeRegExp(raw));
    expect(re.test(raw)).toBe(true);
  });

  it("leaves ordinary characters untouched", () => {
    expect(escapeRegExp("SENTRY_MCP_URL")).toBe("SENTRY_MCP_URL");
  });

  it("escapes a dot so it can't match an arbitrary character", () => {
    // Unescaped, `A.B` would match "AXB"; escaped, it only matches "A.B".
    const re = new RegExp(`^${escapeRegExp("A.B")}$`);
    expect(re.test("A.B")).toBe(true);
    expect(re.test("AXB")).toBe(false);
  });
});
