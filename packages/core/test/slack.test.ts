import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above imports; create the spies with vi.hoisted so the
// mock factories below can reference them.
const { slackChannelMock, connectCredsMock } = vi.hoisted(() => ({
  slackChannelMock: vi.fn((config: unknown) => ({ __config: config })),
  connectCredsMock: vi.fn(() => ({ botToken: "test-token" })),
}));

vi.mock("eve/channels/slack", () => ({
  slackChannel: slackChannelMock,
  defaultSlackAuth: vi.fn(() => ({})),
}));

vi.mock("@vercel/connect/eve", () => ({
  connectSlackCredentials: connectCredsMock,
}));

import { createSlackChannel } from "../src/channels/slack.js";
import type { Roster } from "../src/roster.js";

const roster = {} as Roster;

// Clear ALL mocks (not just slackChannelMock) so call history from connectCredsMock
// or defaultSlackAuth can't leak between tests; clear preserves the vi.fn(impl).
beforeEach(() => {
  vi.clearAllMocks();
});

type SlackConfig = {
  threadContext?: unknown;
  onAppMention: (ctx: unknown, message: { channelId?: string }) => { auth: unknown; context?: string[] };
};

const capturedConfig = (): SlackConfig => slackChannelMock.mock.calls[0]![0] as SlackConfig;

describe("createSlackChannel", () => {
  it("opts into thread-context hydration since the last agent reply", () => {
    createSlackChannel(roster);

    expect(slackChannelMock).toHaveBeenCalledTimes(1);
    // The whole bug is that this option was never set — assert the exact boundary.
    expect(capturedConfig().threadContext).toEqual({ since: "last-agent-reply" });
  });

  it("frames the hydrated thread context as untrusted data on @mention", () => {
    createSlackChannel(roster);

    // No route configured (roster only, empty routes) → onAppMention returns just the
    // untrusted-framing note. It must name the <slack_thread_context> block eve injects.
    const result = capturedConfig().onAppMention({}, { channelId: "C_UNROUTED" });
    expect(result.context).toBeDefined();
    expect(
      result.context!.some((c) => /untrusted/i.test(c) && c.includes("<slack_thread_context>")),
    ).toBe(true);
  });
});
