import { describe, it, expect } from "vitest";
import { clampVerdict, classifyEvent, type WatchToggles } from "../src/watch-gate.js";

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

describe("classifyEvent", () => {
  const toggles = { react: true, reply: true, post: false, palette: ["eyes"] };
  const fakeGen = (object: any) => (async () => ({ object })) as any;

  it("returns the model verdict, clamped", async () => {
    const v = await classifyEvent({ text: "prod is down", recent: "", toggles, generate: fakeGen({ action: "reply", reason: "incident" }) });
    expect(v.action).toBe("reply");
  });
  it("clamps a disabled action to ignore", async () => {
    const v = await classifyEvent({ text: "ship it", recent: "", toggles, generate: fakeGen({ action: "post" }) });
    expect(v.action).toBe("ignore");
  });
  it("fails closed to ignore when the model throws", async () => {
    const boom = (async () => { throw new Error("model down"); }) as any;
    const v = await classifyEvent({ text: "x", recent: "", toggles, generate: boom });
    expect(v.action).toBe("ignore");
  });
});
