import { describe, it, expect } from "vitest";
import { sweepTargets } from "../src/schedules/deskmate-sweep.js";

const routes = {
  C0A: { deskmate: "devops", watch: { digest: true } },
  C0B: { deskmate: "growth_hacker", watch: { reply: true } }, // no digest
  C0C: { deskmate: "devops" },                                 // not watched
};

describe("sweepTargets", () => {
  it("selects only channels with watch.digest", () => {
    expect(sweepTargets(routes as any).map((t) => t.channelId)).toEqual(["C0A"]);
  });
  it("carries the routed deskmate on each target", () => {
    expect(sweepTargets(routes as any)).toEqual([{ channelId: "C0A", deskmate: "devops" }]);
  });
});
