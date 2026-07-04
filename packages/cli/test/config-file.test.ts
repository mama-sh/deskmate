import { describe, it, expect } from "vitest";
import {
  appendConnectionEntry,
  appendDeskmateEntry,
  removeDeskmateEntry,
} from "../src/config-file.js";

const EMPTY_CONFIG = `import { defineTeam } from "@deskmate/core";

export default defineTeam({
  model: "anthropic/claude-sonnet-5",
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
    expect(out).toContain('model: "anthropic/claude-sonnet-5"');
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

describe("appendConnectionEntry — depth-aware key detection", () => {
  // A connection whose NESTED field is named `env` — inserting a top-level `env`
  // connection must not be fooled into a no-op by that nested field.
  const CONFIG_NESTED_ENV = `import { defineTeam } from "@deskmate/core";

export default defineTeam({
  connections: {
    mixpanel: { kind: "mcp", env: "MIXPANEL" },
  },
  deskmates: {},
  channels: {},
});
`;

  it("inserts a real top-level `env` connection despite a nested field named `env`", () => {
    const out = appendConnectionEntry(CONFIG_NESTED_ENV, "env", { kind: "mcp", env: "ENV" });
    // NOT wrongly skipped as already-present:
    expect(out).not.toBe(CONFIG_NESTED_ENV);
    // A real top-level `env: { … }` entry was inserted, alongside mixpanel:
    expect(out).toContain("env: {");
    expect(out).toContain("mixpanel: {");
    expect(out).toContain('env: "ENV"');
    // brace balance preserved
    expect((out.match(/\{/g) ?? []).length).toBe((out.match(/\}/g) ?? []).length);
  });

  it("is still a no-op for a genuine top-level duplicate connection", () => {
    const out = appendConnectionEntry(CONFIG_NESTED_ENV, "mixpanel", { kind: "mcp", env: "MIXPANEL" });
    expect(out).toBe(CONFIG_NESTED_ENV);
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
