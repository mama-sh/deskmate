import { describe, it, expect } from "vitest";
import { houseStyle } from "../src/house-style.js";

describe("houseStyle", () => {
  it("is non-empty prose with the voice and work sections", () => {
    expect(houseStyle).toContain("## How you write");
    expect(houseStyle).toContain("## Grounding and clarifying");
  });

  it("names the highest-signal anti-AI rules", () => {
    expect(houseStyle).toContain("Lead with the answer");
    expect(houseStyle).toContain("clarifying question");
    expect(houseStyle.toLowerCase()).toContain("reread");
  });

  // Regression guard: the block IS our anti-slop checklist, so a future edit must not
  // silently drop the highest-signal tells it bans.
  it("keeps banning the highest-signal AI tells", () => {
    for (const tell of ["inline-header", "em dashes", "delve"]) {
      expect(houseStyle.toLowerCase()).toContain(tell.toLowerCase());
    }
  });
});
