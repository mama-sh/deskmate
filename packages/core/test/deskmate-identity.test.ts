import { describe, expect, it } from "vitest";
import { deskmateRoster, deskmateSlackIdentity } from "../src/deskmate-identity.js";
import type { Roster } from "../src/roster.js";

// Fixture roster passed into the (now roster-parameterized) identity helpers.
// `sales_rep` has no bundled avatar, so its identity resolves deterministically to
// the emoji fallback regardless of DESKMATE_PUBLIC_URL / VERCEL_* in the env.
const roster: Roster = {
  devops: {
    id: "devops",
    displayName: "DevOps Engineer",
    emoji: ":wrench:",
    summary: "Triages incidents; proposes fixes.",
    providers: ["sentry"],
  },
  product_analyst: {
    id: "product_analyst",
    displayName: "Product Analyst",
    emoji: ":bar_chart:",
    summary: "Turns usage data into a short narrative.",
    providers: ["mixpanel"],
  },
  sales_rep: {
    id: "sales_rep",
    displayName: "Sales Rep",
    emoji: ":telephone:",
    summary: "Handles inbound leads.",
    providers: [],
  },
};

describe("deskmateRoster", () => {
  it("lists each deskmate id, name, and one-line role", () => {
    const listed = deskmateRoster(roster);
    expect(listed).toContain("devops");
    expect(listed).toContain("DevOps Engineer");
    expect(listed).toContain("product_analyst");
    expect(listed).toContain("Product Analyst");
  });

  it("can exclude one deskmate (so a deskmate isn't offered itself)", () => {
    const listed = deskmateRoster(roster, "devops");
    expect(listed).not.toContain("devops");
    expect(listed).toContain("product_analyst");
  });
});

describe("deskmateSlackIdentity", () => {
  it("resolves a deskmate to its sender name, falling back to the emoji icon", () => {
    const identity = deskmateSlackIdentity(roster, "sales_rep");
    expect(identity).toEqual({ username: "Sales Rep", icon_emoji: ":telephone:" });
  });

  it("returns null for an unknown id", () => {
    expect(deskmateSlackIdentity(roster, "ghost")).toBeNull();
  });

  it("returns null for a null/undefined id", () => {
    expect(deskmateSlackIdentity(roster, null)).toBeNull();
    expect(deskmateSlackIdentity(roster, undefined)).toBeNull();
  });
});
