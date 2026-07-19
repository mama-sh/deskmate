# Slack Thread-Context Hydration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Make a deskmate see the prior thread messages when it is `@mentioned` for the first time inside a pre-existing Slack thread, by opting into eve's built-in `threadContext` hydration.

**Architecture:** One config option on the `slackChannel({...})` call inside `createSlackChannel` (`packages/core/src/channels/slack.ts`). eve's `dispatchInboundMessage` already calls `loadThreadContextMessages` + `formatSlackThreadContext` whenever `threadContext` is set; we set it to `{ since: "last-agent-reply" }`. Fix is scoped to the managed `@mention` path (the reproduced bug); the ambient thread-follow path goes through `receive()` and is unaffected.

**Tech Stack:** TypeScript, eve `^0.19.0` (`eve/channels/slack`), Vitest, pnpm workspace.

**Design doc:** `docs/plans/2026-07-18-slack-thread-context-design.md`

**Note on commits:** The user's standing preference is *do not auto-commit*. Commit steps are written into the plan for completeness, but the executing agent MUST get explicit user confirmation before running any `git commit`.

---

### Task 1: Add the failing test for `threadContext` wiring

**Files:**
- Create: `packages/core/test/slack.test.ts`

Core has no eve mocks today and no `slack.test.ts`. This test introduces the first `vi.mock("eve/channels/slack")`. It mocks `eve/channels/slack` (so `slackChannel` becomes a spy that captures its config and returns a sentinel) and `@vercel/connect/eve` (so `connectSlackCredentials` doesn't touch any real connector). It then asserts `createSlackChannel` passes `threadContext: { since: "last-agent-reply" }`.

`vi.mock` is hoisted above imports, so the spies are created with `vi.hoisted` to be referenceable inside the mock factories.

**Step 1: Write the failing test**

```ts
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
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/core exec vitest run test/slack.test.ts`
Expected: FAIL — `config.threadContext` is `undefined`, so `toEqual({ since: "last-agent-reply" })` fails.

(If `roster.js` isn't the correct type export path, confirm with `grep -n "export" packages/core/src/roster.ts` — a type-only import means no runtime dependency either way.)

---

### Task 2: Implement the one-line change and verify green

**Files:**
- Modify: `packages/core/src/channels/slack.ts` (the `slackChannel({...})` call, currently starting line 80)

**Step 1: Add the `threadContext` option**

In `createSlackChannel`, add the option immediately after `credentials`:

```ts
  return slackChannel({
    credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/deskmate"),
    // Hydrate prior thread messages on the FIRST @mention into an existing thread.
    // eve injects a <slack_thread_context> block (sender_type-tagged) via
    // dispatchInboundMessage whenever this is set. "last-agent-reply": first mention
    // (no agent reply yet) pulls the whole thread from the root; later turns add only
    // the gap messages not already in the session. See
    // docs/plans/2026-07-18-slack-thread-context-design.md.
    threadContext: { since: "last-agent-reply" },
    onAppMention: (ctx, message) => {
      // ...unchanged
```

Leave `onAppMention` and `events` exactly as they are.

**Step 2: Run the test to verify it passes**

Run: `pnpm --filter @deskmate/core exec vitest run test/slack.test.ts`
Expected: PASS.

**Step 3: Typecheck the change**

The `threadContext` field is typed `LoadThreadContextMessagesOptions` (`{ since?: ThreadContextSince }`), and `ThreadContextSince` includes the literal `"last-agent-reply"`, so `{ since: "last-agent-reply" }` typechecks.

Run: `pnpm --filter @deskmate/core build` (or the package's typecheck script if separate)
Expected: no type errors.

---

### Task 3: Full verification and commit

**Step 1: Run the whole test suite**

Run: `pnpm -r test`
Expected: PASS. In particular, `packages/cli/test/render.test.ts` stays green — its shim assertions don't reference `threadContext`, so no shim change is needed.

**Step 2: Confirm before committing (standing preference)**

Do NOT commit without the user's explicit go-ahead. Once confirmed:

```bash
git add packages/core/src/channels/slack.ts \
        packages/core/test/slack.test.ts \
        docs/plans/2026-07-18-slack-thread-context.md \
        docs/plans/2026-07-18-slack-thread-context-design.md
git commit -m "$(cat <<'EOF'
fix(core): hydrate Slack thread context on first @mention into an existing thread

Set threadContext:{ since: "last-agent-reply" } on createSlackChannel so eve
injects prior thread messages when a deskmate is @mentioned into a thread it has
not yet spoken in. Fixes the case where the bot answered "which system?" because
the parent message and prior replies were never in context.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Step 3 (optional): Live smoke**

If desired, `deskmate dev` against a real workspace: @mention the bot as a fresh reply inside an existing multi-message thread and confirm the reply reflects the parent context rather than asking for clarification.

---

## Follow-ups (out of scope — tracked, not built)

> Injection labeling parity was originally deferred here but was implemented in
> this PR after Copilot flagged the injection surface: `onAppMention` now returns
> an untrusted-data note framing the `<slack_thread_context>` block.

1. Scope/membership: `threadContext` needs `channels:history` (+ `groups:history` for private) and bot membership; note it in the PR for DMs / private channels.
2. Per-team config surface for the `since` boundary (currently hardcoded in core).
