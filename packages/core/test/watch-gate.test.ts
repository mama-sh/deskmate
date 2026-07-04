import { describe, it, expect } from "vitest";
import { clampVerdict, type WatchToggles } from "../src/watch-gate.js";

const toggles: WatchToggles = { react: true, reply: true, post: true, palette: ["eyes", "tada"] };

describe("clampVerdict", () => {
  it("passes a valid react with an in-palette emoji (strips colons)", () => {
    expect(clampVerdict({ action: "react", emoji: ":eyes:" }, toggles)).toEqual({ action: "react", emoji: "eyes", reason: undefined });
  });
  it("downgrades a react with an out-of-palette emoji to ignore", () => {
    expect(clampVerdict({ action: "react", emoji: "fire" }, toggles).action).toBe("ignore");
  });
  it("downgrades react to ignore when react is disabled", () => {
    expect(clampVerdict({ action: "react", emoji: "eyes" }, { ...toggles, react: false }).action).toBe("ignore");
  });
  it("downgrades post to ignore when post is disabled", () => {
    expect(clampVerdict({ action: "post" }, { ...toggles, post: false }).action).toBe("ignore");
  });
  it("passes reply and post when enabled", () => {
    expect(clampVerdict({ action: "reply" }, toggles).action).toBe("reply");
    expect(clampVerdict({ action: "post" }, toggles).action).toBe("post");
  });
  it("treats an unknown action as ignore", () => {
    expect(clampVerdict({ action: "banana" as any }, toggles).action).toBe("ignore");
  });
});
