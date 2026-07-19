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

beforeEach(() => {
  slackChannelMock.mockClear();
});

describe("createSlackChannel", () => {
  it("opts into thread-context hydration since the last agent reply", () => {
    createSlackChannel(roster);

    expect(slackChannelMock).toHaveBeenCalledTimes(1);
    const config = slackChannelMock.mock.calls[0]![0] as { threadContext?: unknown };
    // The whole bug is that this option was never set — assert the exact boundary.
    expect(config.threadContext).toEqual({ since: "last-agent-reply" });
  });
});
