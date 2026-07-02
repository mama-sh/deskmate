import { describe, expect, it } from "vitest";
import { nextConveneDecision, type ConveneState } from "../agent/lib/convene.js";

describe("nextConveneDecision", () => {
  it("allows the first turn and increments the counter", () => {
    const s: ConveneState = {};
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: true, turnId: "t1", turns: 1 });
  });

  it("keeps counting within the same turn (conversation)", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 2 };
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: true, turnId: "t1", turns: 3 });
  });

  it("resets the counter when a new user turn starts", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 5 };
    expect(nextConveneDecision(s, "t2", 6)).toEqual({ post: true, turnId: "t2", turns: 1 });
  });

  it("refuses to post once the cap is reached", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 6 };
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: false, turnId: "t1", turns: 6 });
  });
});
