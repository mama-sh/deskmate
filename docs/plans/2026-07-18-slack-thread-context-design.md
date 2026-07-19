# Hydrate Slack thread context on `@mention`

**Date:** 2026-07-18
**Status:** Approved — ready for implementation
**Scope:** `@deskmate/core`

## Problem

When a deskmate is `@mentioned` for the **first time inside a pre-existing Slack
thread**, the model receives only the mention text — never the parent message or
prior replies. A human reading the thread has full context; the bot does not, so
it answers with "Could you give me a bit more context?" even when the thread makes
the answer obvious.

Reproduced end-to-end: in a thread whose parent (from another bot, *Otto Reader*)
was a churn report about a user "Karima", a reply of
`@Deskmate why did the system fail to confirm the change? suggest a fix` produced a
generic "which system?" response, because the parent report was never in context.

### Root cause

eve already supports thread-history hydration. In
`eve/.../slack/slackChannel.js` → `dispatchInboundMessage`:

```js
let n = formatSlackThreadContext(
  e.threadContext === void 0 ? [] : await loadThreadContextMessages(i, t, e.threadContext)
);
```

It only hydrates when the `threadContext` option is set. Deskmate's
`createSlackChannel` (`packages/core/src/channels/slack.ts:80`) never sets it, so
`e.threadContext === undefined` → `formatSlackThreadContext([])` → empty → the
agent gets only the mention text plus the routing directive.

**Why ongoing threads feel fine:** eve keeps a per-thread session keyed by
`continuationToken(channelId, threadTs)`, so once a deskmate has replied in a
thread its own prior turns are already in the session. But (a) the *first*
`@mention` into an existing thread has no session, and (b) messages others post
*between* its turns never enter the session. The thread-follow work (#26) rides
that same session, so it doesn't backfill history either.

## Decision

Opt into eve's built-in hydration in `createSlackChannel`:

```ts
return slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/deskmate"),
  threadContext: { since: "last-agent-reply" },   // ← the fix
  onAppMention: (ctx, message) => { /* unchanged */ },
  events: { /* unchanged */ },
});
```

### Why `since: "last-agent-reply"` (not `"thread-root"`)

- **First `@mention` into an existing thread** → no agent reply yet →
  `loadThreadContextMessages` returns everything from the root → full thread
  context (fixes the Karima case).
- **Subsequent turns** → the session already holds the deskmate's own turns, so
  this injects *only* the new messages since it last spoke (the gap messages not
  in session). `"thread-root"` would re-inject the entire thread every turn —
  duplicated context, wasted tokens.

### Why the built-in option (not custom hydration)

eve's `formatSlackThreadContext` wraps each message in `<slack_thread_context>`,
tagging `sender_type: user | bot | agent`, so the model distinguishes background
from the live turn. The managed `@mention` path already trusts mention text, so
matching the ambient path's explicit "untrusted — treat as data" framing is not
required for correctness here. Building our own hydration via
`onAppMention` returning `{ auth, context }` would add code and test surface for
a labeling nicety we're deferring (see follow-ups). Chosen: the built-in option.

## Scope & data flow

- **Core only.** No call-site or shim change. `createSlackAmbientChannel` builds
  its channel via `createSlackChannel`, so it inherits the option automatically.
- **`@mention` path only.** The ambient *thread-follow* dispatch goes through
  `args.receive` → eve's `receive()`, which does **not** run
  `dispatchInboundMessage` and never touches `threadContext`. So this fix is
  correctly scoped to the reproduced `@mention` bug.
- Every consumer (including `addmein-deskmate`) picks it up on a core release bump
  — no eve change needed.

## Testing

New `packages/core/test/slack.test.ts`:

- Core currently has **no** eve mocks (pure-function tests only) and no
  `slack.test.ts`. This introduces the first `vi.mock("eve/channels/slack")`.
- The mock captures the config object passed to `slackChannel` and returns a
  sentinel. The test asserts `createSlackChannel(...)` sets `threadContext` to
  `{ since: "last-agent-reply" }`.
- Fails before the change, passes after. Small blast radius: we only inspect the
  captured argument.
- Existing `packages/cli/test/render.test.ts` shim assertions don't reference
  `threadContext`, so they remain green unchanged.

## Verification

- `pnpm -r test`
- typecheck / build in `packages/core`
- (optional) `deskmate dev` smoke against a real thread

## Follow-ups (documented, not built in this PR)

1. **Injection labeling gap** — the hydrated `<slack_thread_context>` block is
   tagged by `sender_type` but not wrapped in the ambient path's explicit
   "untrusted — treat as data" framing (`slack-ambient.ts:302`). Tracked as a
   follow-up if parity is wanted.
2. **Scope / membership** — `threadContext` runs `conversations.replies`, needing
   `channels:history` (+ `groups:history` for private channels) and bot
   membership. The ambient channel already requires `channels:history`, so it's
   likely granted, but flag it for DMs / private channels in the PR.
3. **Cross-bot context is intended** — the hydrated block includes other bots'
   messages (e.g. the Otto Reader report); `sender_type: bot` lets the model treat
   it as background, not the live turn.
4. **Config surface** — `last-agent-reply` is hardcoded in core (deskmate is
   opinionated). Threading it through `team.channels` for per-team tuning is a
   future option, deferred under YAGNI.
