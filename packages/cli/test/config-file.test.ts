import { describe, it, expect } from "vitest";
import { appendDeskmateEntry, removeDeskmateEntry } from "../src/config-file.js";

const EMPTY_CONFIG = `import { defineTeam } from "@deskmate/core";

export default defineTeam({
  model: "anthropic/claude-sonnet-4.6",
  connections: {},
  deskmates: {},
  channels: {},
});
`;

const PA = {
  role: "product_analyst",
  emoji: ":bar_chart:",
  displayName: "Product Analyst",
  summary: "Turns product usage data into a short narrative.",
  skill: "ncklrs/startup-os-skills@product-analyst",
  reads: ["mixpanel"],
};

const DEVOPS = {
  role: "devops",
  emoji: ":wrench:",
  displayName: "DevOps Engineer",
  summary: "Triages incidents.",
  skill: "erichowens/some_claude_skills@logging-observability",
  reads: ["sentry"],
};

describe("appendDeskmateEntry", () => {
  it("inserts a new deskmates.<id> key with all fields", () => {
    const out = appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA);
    expect(out).not.toBe(EMPTY_CONFIG);
    expect(out).toContain("product_analyst: {");
    expect(out).toContain('role: "product_analyst"');
    expect(out).toContain('emoji: ":bar_chart:"');
    expect(out).toContain('displayName: "Product Analyst"');
    expect(out).toContain('skill: "ncklrs/startup-os-skills@product-analyst"');
    expect(out).toContain('reads: ["mixpanel"]');
  });

  it("preserves the rest of the source (other top-level keys untouched)", () => {
    const out = appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA);
    expect(out).toContain('import { defineTeam } from "@deskmate/core";');
    expect(out).toContain('model: "anthropic/claude-sonnet-4.6"');
    expect(out).toContain("connections: {}");
    expect(out).toContain("channels: {}");
    // brace balance is preserved
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
  });

  it("is idempotent: a no-op when the id already exists", () => {
    const once = appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA);
    const twice = appendDeskmateEntry(once, "product_analyst", PA);
    expect(twice).toBe(once);
  });

  it("keeps existing entries when adding another deskmate", () => {
    const one = appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA);
    const two = appendDeskmateEntry(one, "devops", DEVOPS);
    expect(two).toContain("product_analyst: {");
    expect(two).toContain("devops: {");
    expect(two).toContain('reads: ["sentry"]');
    expect((two.match(/\{/g) ?? []).length).toBe((two.match(/\}/g) ?? []).length);
  });

  it("throws when there is no deskmates object to insert into", () => {
    expect(() => appendDeskmateEntry(`export default {};\n`, "x", PA)).toThrow();
  });
});

describe("removeDeskmateEntry", () => {
  it("removes an existing deskmates.<id> key and leaves the rest", () => {
    const two = appendDeskmateEntry(appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA), "devops", DEVOPS);
    const out = removeDeskmateEntry(two, "devops");
    expect(out).not.toContain("devops: {");
    expect(out).toContain("product_analyst: {");
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
  });

  it("is a no-op when the id is absent", () => {
    const one = appendDeskmateEntry(EMPTY_CONFIG, "product_analyst", PA);
    expect(removeDeskmateEntry(one, "devops")).toBe(one);
  });
});
