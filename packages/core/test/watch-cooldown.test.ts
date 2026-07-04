import { describe, it, expect } from "vitest";
import { lastBotReplySec, withinCooldown } from "../src/channels/watch-cooldown.js";

const BOT = "U_BOT";
const replies = [
  { user: "U1", ts: "1000.000100" },
  { user: BOT, ts: "1500.000200" },
  { user: "U2", ts: "1600.000300" },
];

describe("watch-cooldown", () => {
  it("finds the bot's most recent reply time in seconds", () => {
    expect(lastBotReplySec(replies, BOT)).toBe(1500.0002);
  });
  it("returns null when the bot never posted", () => {
    expect(lastBotReplySec(replies, "U_OTHER")).toBeNull();
  });
  it("is within cooldown when the bot posted recently", () => {
    // now = 1500 + 5min*60 → still inside a 10-min window
    expect(withinCooldown(replies, BOT, 1500 + 5 * 60, 10)).toBe(true);
  });
  it("is NOT within cooldown after the window passes", () => {
    expect(withinCooldown(replies, BOT, 1500 + 11 * 60, 10)).toBe(false);
  });
  it("is never within cooldown when the bot hasn't posted", () => {
    expect(withinCooldown(replies, "U_OTHER", 9999, 10)).toBe(false);
  });
});
