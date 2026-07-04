import { afterEach, describe, expect, it } from "vitest";
import { maxTurns, nextConveneDecision, type ConveneState } from "../src/convene.js";

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

describe("maxTurns", () => {
  afterEach(() => {
    delete process.env.DESKMATE_MAX_TURNS;
  });

  it("returns the fallback (config cap) when the env var is unset", () => {
    delete process.env.DESKMATE_MAX_TURNS;
    expect(maxTurns(3)).toBe(3);
  });

  it("defaults the fallback to 6 when no arg is given", () => {
    delete process.env.DESKMATE_MAX_TURNS;
    expect(maxTurns()).toBe(6);
  });

  it("lets a valid env var override the fallback (ops escape hatch)", () => {
    process.env.DESKMATE_MAX_TURNS = "9";
    expect(maxTurns(3)).toBe(9);
  });

  it("ignores an invalid env var and uses the fallback", () => {
    process.env.DESKMATE_MAX_TURNS = "not-a-number";
    expect(maxTurns(3)).toBe(3);
    process.env.DESKMATE_MAX_TURNS = "0";
    expect(maxTurns(3)).toBe(3);
  });
});
