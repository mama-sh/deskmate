import { describe, expect, it } from "vitest";
import { deskmateRoster } from "../agent/lib/deskmate-identity.js";

describe("deskmateRoster", () => {
  it("lists each deskmate id, name, and one-line role", () => {
    const roster = deskmateRoster();
    expect(roster).toContain("devops");
    expect(roster).toContain("DevOps Engineer");
    expect(roster).toContain("product_analyst");
    expect(roster).toContain("Product Analyst");
  });

  it("can exclude one deskmate (so a deskmate isn't offered itself)", () => {
    const roster = deskmateRoster("devops");
    expect(roster).not.toContain("devops");
    expect(roster).toContain("product_analyst");
  });
});
