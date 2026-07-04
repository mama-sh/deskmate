import { describe, it, expect } from "vitest";
import { withDeltas } from "../roles/product_analyst/tools/get_metric_snapshot.js";

describe("withDeltas", () => {
  it("computes absolute and percent delta vs previous", () => {
    expect(withDeltas([{ name: "signups", value: 120, previous: 100 }])).toEqual([
      { name: "signups", value: 120, previous: 100, delta: 20, deltaPct: 20 },
    ]);
  });

  it("handles a zero previous without dividing by zero", () => {
    const [row] = withDeltas([{ name: "x", value: 5, previous: 0 }]);
    expect(row.delta).toBe(5);
    expect(row.deltaPct).toBeNull();
  });
});
