import { describe, it, expect } from "vitest";
import { funnelConversion } from "../library/deskmates/growth_hacker/tools/get_funnel_snapshot.js";

describe("funnelConversion", () => {
  it("computes step-over-step and step-over-top conversion as percentages", () => {
    expect(
      funnelConversion([
        { name: "visited", count: 1000 },
        { name: "signed_up", count: 200 },
        { name: "activated", count: 50 },
      ]),
    ).toEqual([
      { name: "visited", count: 1000, conversionFromPrev: null, conversionFromTop: 100 },
      { name: "signed_up", count: 200, conversionFromPrev: 20, conversionFromTop: 20 },
      { name: "activated", count: 50, conversionFromPrev: 25, conversionFromTop: 5 },
    ]);
  });

  it("returns [] for no steps", () => {
    expect(funnelConversion([])).toEqual([]);
  });

  it("handles a zero top/previous without dividing by zero", () => {
    const [first, second] = funnelConversion([
      { name: "a", count: 0 },
      { name: "b", count: 5 },
    ]);
    expect(first).toEqual({ name: "a", count: 0, conversionFromPrev: null, conversionFromTop: 0 });
    expect(second).toEqual({ name: "b", count: 5, conversionFromPrev: null, conversionFromTop: 0 });
  });
});
