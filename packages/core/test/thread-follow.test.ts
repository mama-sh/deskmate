import { describe, it, expect } from "vitest";
import { isBareAck, shouldFollowThread } from "../src/channels/thread-follow.js";

const BOT = "U_BOT";
const USER = "U_HUMAN";

// A thread the bot has already spoken in (root by a human, one bot reply).
const joinedThread = [
  { user: USER },
  { user: BOT },
];
// A thread the bot has NOT spoken in.
const strangerThread = [{ user: USER }, { user: "U_OTHER" }];

describe("isBareAck", () => {
  it("treats bare gratitude/closure as an ack", () => {
    for (const t of ["thanks", "Thanks!", "thank you", "thx", "ty", "ok", "okay", "kk", "got it", "gotcha", "no problem", "np", "sounds good", "perfect", "👍", "🙏"]) {
      expect(isBareAck(t), t).toBe(true);
    }
  });
  it("treats an empty / whitespace message as an ack (nothing to answer)", () => {
    expect(isBareAck("   ")).toBe(true);
  });
  it("does NOT treat a real follow-up as an ack", () => {
    for (const t of ["what about staging?", "can you also check the logs", "thanks, but one more thing", "ok do it then"]) {
      expect(isBareAck(t), t).toBe(false);
    }
  });
});

describe("shouldFollowThread", () => {
  // The regression: a no-mention reply in a thread the bot is active in must be followed.
  it("follows a plain reply in a thread the bot already joined", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: "what about staging?", thread_ts: "100.1", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(true);
  });

  it("does NOT follow when the bot has never posted in the thread", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: "anyone around?", thread_ts: "100.1", ts: "200.2" },
      botUserId: BOT,
      threadMessages: strangerThread,
    });
    expect(d.follow).toBe(false);
    expect(d.reason).toMatch(/not active/i);
  });

  it("does NOT follow a top-level message (no thread_ts)", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: "hello team", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(false);
    expect(d.reason).toMatch(/not a thread reply/i);
  });

  it("does NOT follow the thread root itself (thread_ts === ts)", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: "kicking off a thread", thread_ts: "200.2", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(false);
    expect(d.reason).toMatch(/not a thread reply/i);
  });

  it("defers an @mention to the managed channel", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: `hey <@${BOT}> what's up`, thread_ts: "100.1", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(false);
    expect(d.reason).toMatch(/mention/i);
  });

  it("ignores the bot's own message", () => {
    const d = shouldFollowThread({
      event: { user: BOT, text: "here is the answer", thread_ts: "100.1", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(false);
  });

  it("stays silent on a bare acknowledgement in a joined thread", () => {
    const d = shouldFollowThread({
      event: { user: USER, text: "thanks!", thread_ts: "100.1", ts: "200.2" },
      botUserId: BOT,
      threadMessages: joinedThread,
    });
    expect(d.follow).toBe(false);
    expect(d.reason).toMatch(/ack/i);
  });
});
