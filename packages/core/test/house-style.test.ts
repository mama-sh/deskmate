import { describe, it, expect } from "vitest";
import { houseStyle } from "../src/house-style.js";

describe("houseStyle", () => {
  it("is non-empty prose with the voice and work sections", () => {
    expect(houseStyle).toContain("## How you write");
    expect(houseStyle).toContain("## How you work");
  });

  it("names the highest-signal anti-AI rules", () => {
    expect(houseStyle).toContain("Lead with the answer");
    expect(houseStyle).toContain("clarifying question");
    expect(houseStyle.toLowerCase()).toContain("reread");
  });
});
