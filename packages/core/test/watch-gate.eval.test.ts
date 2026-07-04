import { describe, it, expect } from "vitest";
import { clampVerdict } from "../src/watch-gate.js";

const chatter = [
  { action: "react", emoji: "fire" },      // out of palette -> ignore
  { action: "post" },                       // post disabled -> ignore
  { action: "reply" },                      // reply disabled -> ignore
];

describe("anti-spam: disabled/invalid actions collapse to ignore", () => {
  const quiet = { react: true, reply: false, post: false, palette: ["eyes"] };
  it("keeps a read-only channel silent", () => {
    for (const raw of chatter) expect(clampVerdict(raw as any, quiet).action).toBe("ignore");
  });
});
