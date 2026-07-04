# Proactive channel watching — design

**Date:** 2026-07-04
**Status:** Approved (brainstorming); implementation plan to follow.
**Depends on:** the ambient channel (`packages/core/src/channels/slack-ambient.ts`),
per-deskmate identity + `message.completed` delivery (`slack.ts`), and the convene
machinery (`convene.ts`, `deskmate-says.ts`) — all reused, not replaced.

## Problem

Deskmates are entirely **reactive** today. They act only when summoned: an `@mention`
or DM (`slack.ts`), or an ambient thread reply — but only in threads the bot has
**already joined** and only when a binary LLM gate says the message is for it
(`slack-ambient.ts`). A deskmate never watches a channel it hasn't been pulled into,
never opens a thread on its own, never adds a reaction, and never posts on a cadence.

We want deskmates to **proactively watch opted-in channels** and act with three
gestures: add an emoji **reaction**, drop a **thread answer**, or make a **top-level
post** — while staying quiet enough that the presence reads as a helpful coworker, not
a spam bot.

## Decisions (from brainstorming)

1. **Surface:** Slack only for MVP. Other surfaces (GitHub, Discord) are later work.
2. **Trigger model:** *Both.* Event-driven for in-the-moment reactions/replies, plus a
   scheduled sweep for digests and catch-ups.
3. **Scope / control:** *Explicit per-channel opt-in.* Nothing proactive happens in a
   channel unless its route carries a `watch` block. The channel's **routed deskmate**
   is the default actor; a config knob (`picker: "frontdesk"`) widens it to
   front-desk-picks-by-domain.
4. **Autonomy:** *Tiered by noise.* Reactions run free (behind the gate), thread replies
   run autonomously behind the gate + a per-thread cooldown, and top-level posts face the
   highest bar (off by default, strong gate, daily cap, optional HITL approval).
5. **Reactions:** expressive and **topic-appropriate** (not only 👀/✅ — also 🎉 for a
   genuine win, ⚠️ for a risk, etc.), chosen from a config-tunable palette, but only when
   clearly relevant (default gate verdict is `ignore`).
6. **Inbound reaction watching (`summonEmoji`) is dropped for MVP.** The bot adds
   reactions but does not watch human ones. Can revisit later.

## Architecture (Approach A — two-tier watcher)

Chosen over "everything through the agent" (a full model turn per watched message,
untenable in a busy channel) and "scheduled-only" (not real-time). Approach A is the only
option that is both real-time and cost-sane, and it maximally reuses existing machinery.

Generalize `slack-ambient.ts` from "reply in threads I already joined" into a **watcher**
over opted-in channels. It keeps its existing Connect trigger route
(`/eve/v1/slack-ambient`, so no re-provisioning); the Slack app's event subscription
gains `message.channels` for *all* messages (not just joined threads), and the app gains
the `reactions:write` scope.

### Inbound event flow

```
Slack event → webhook (/eve/v1/slack-ambient)
  ├─ verify (Connect webhookVerifier) + dedupe (event_id + drop Slack retries)
  ├─ resolve channel route → is this channel watched? → no: 200 ok, done
  └─ waitUntil(async):
       Tier 1 — CHEAP GATE (one small LLM call, NO agent turn)
         classify event → { action: ignore | react | reply | post, emoji?, reason }
           honoring the channel's watch toggles; default verdict is `ignore`
         ├─ ignore → log why, stop            (the common case, one cheap call)
         ├─ react  → reactions.add(emoji) INLINE, done   (free tier, no agent turn)
         └─ reply | post → Tier 2 ↓
       Tier 2 — ENGAGE (full turn through the front desk, exactly as ambient does today)
         idempotency / cooldown check via Slack (already-posted? recent reply? daily cap?)
         args.receive(slack, { message, target, auth, [routing directive] })
           → front desk routes to the deskmate → posts AS them
             (reuses convene, per-deskmate identity, house-style voice, HITL)
```

The loud-and-frequent path (watch → ignore/react) never touches the expensive agent.
Full turns are reserved for genuine engagement.

### Entry points → the three gestures

- **emoji reactions** → Tier-1 inline `reactions.add`. Cheapest, highest frequency, no
  agent turn. Topic-appropriate emoji from a curated palette; `ignore` unless it clearly
  fits.
- **thread answers** → Tier-2 engage → reply under the watched message
  (`threadTs = message.ts`). New vs. today: can start a reply in a thread the bot has not
  joined yet (treated as an initiation, gated).
- **top-level posts** → primarily the **scheduled sweep** (below); optionally a Tier-2
  `post` verdict. Off by default.

### Scheduled sweep

One generated `agent/schedules/deskmate-sweep.ts`, built from a core
`createDeskmateSweep(roster, routes)` factory. Its `run` handler iterates channels whose
`watch` enables `digest`, and for each calls
`receive(slack, { message: "review recent activity in this channel; post/react only if
warranted", target: { channelId }, auth: appAuth })`. eve anchors a fresh session and the
first agent post lands as a top-level message. The cadence is one **team-level** static
cron (`sweep.cron`, default `0 9 * * 1-5`), because eve bakes a single cron into a Vercel
Cron Job at build time; per-channel cadences would need one generated schedule file per
distinct cron (deferred). Generated only when at least one channel sets `digest: true`.
This is **Phase 2** — the event-driven watcher (Phase 1) ships first.

## Config surface

One new optional `watch` block on a channel route. No `watch` = today's reactive-only
behavior, untouched.

```ts
// deskmate.config.ts
channels: {
  "C0123INCIDENTS": {
    deskmate: "devops",
    lock: true,
    watch: {
      react:  true,          // Tier-1 emoji reactions              (default true)
      reply:  true,          // Tier-2 thread answers               (default true)
      post:   false,         // Tier-2 / sweep top-level posts      (default false)
      approvePosts: true,    // HITL approve/reject before a post lands (default false)
      picker: "routed",      // "routed" (default) | "frontdesk"
      reactionPalette: ["eyes", "white_check_mark", "tada", "warning"], // optional; curated default otherwise
      digest: true,          // include this channel in the scheduled sweep (Phase 2)
    },
  },
},
// Team-level sweep cadence (one static cron; eve bakes it into a Vercel Cron at build).
sweep: { cron: "0 9 * * 1-5" },  // default when omitted
```

- `react` — free tier, bounded by the gate + Slack's natural idempotency
  (`already_reacted` is harmless). Emoji chosen from `reactionPalette` (curated default).
- `reply` — autonomous behind the gate + a per-thread cooldown
  (`DESKMATE_REPLY_COOLDOWN_MIN`), derived from Slack.
- `post` — off by default. When on: strongest gate + a daily per-channel cap
  (`DESKMATE_POST_DAILY_CAP`) + optional `approvePosts` HITL.
- `picker` — `"routed"` dispatches to the channel's routed deskmate with the same
  `[routing]` directive `onAppMention` injects; `"frontdesk"` omits the lock and lets the
  front desk pick by domain.

### Global env knobs (match the existing `DESKMATE_*` style)

- `DESKMATE_GATE_MODEL` — already exists; reused for the action-selector gate. Defaults to
  a cheap model (it fires on every watched event).
- `DESKMATE_WATCH_DISABLED` — kill switch for the whole watch layer.
- `DESKMATE_REPLY_COOLDOWN_MIN` / `DESKMATE_POST_DAILY_CAP` — tuning, with config defaults.

## State / idempotency (no new infra)

The watcher webhook is a raw route handler, not a session, so eve's per-session
`defineState` does not apply. Slack itself is the coordination substrate:

- **Reply cooldown** — read `conversations.replies` (the watcher already fetches this) and
  skip if the bot posted in that thread within the cooldown window.
- **Reaction idempotency** — `already_reacted` is a harmless no-op.
- **Post daily cap** — best-effort from `conversations.history` (bot's own top-level posts
  in 24h).
- **Event dedupe** — drop Slack retries via the `X-Slack-Retry-Num` header + the existing
  in-memory `seenEventIds` (best-effort). The residual double-dispatch race is closed by
  the "already posted here?" Slack read before engaging.

A durable external store for *hard* global rate-caps is a noted future upgrade, not MVP.

## Error handling

All failures fail **closed** (toward silence) and never break the webhook's 200 ack:

- Gate LLM throws → treat as `ignore` (today's `shouldRespond` posture).
- `reactions.add` error (`not_in_channel`, `already_reacted`) → log, no-op.
- Engagement dispatch failure → logged; reuses the existing "post under the shared bot if
  the identity post fails" fallback.
- Channel not opted in, or `DESKMATE_WATCH_DISABLED` set → immediate 200, zero work.

## Testing

- **Unit:** gate action-selector (mocked model) → each verdict; watch-config resolution
  (opted-in/out, toggles, `picker`); reaction-palette validation; cooldown logic against a
  `conversations.replies` fixture; zod `watch` parse + defaults; **deterministic sync
  render of the `watch` field** (updates the existing byte-exact sync tests).
- **Anti-spam eval:** a batch of sample messages → the gate returns mostly `ignore`.
- **Green baseline:** `pnpm typecheck && pnpm test && pnpm build`.
- **Sandbox integration:** opted-in channel → post a message → observe a react or a
  threaded reply; verify the cooldown blocks a rapid re-reply and the daily cap bounds
  posts.

## Files touched

- Generalize `packages/core/src/channels/slack-ambient.ts` into the watcher (keep the
  filename + route to avoid re-provisioning; expand internals), plus a small
  `packages/core/src/watch-gate.ts` for the action-selector + palette.
- New `packages/core/src/schedules/deskmate-sweep.ts` (`createDeskmateSweep` factory).
- Edit `packages/core/src/channel-routes.ts` (`watch` type + resolvers),
  `packages/core/src/config.ts` (zod `watch`).
- Edit `packages/cli/src/sync/render.ts` (serialize `watch`; render the sweep schedule) +
  `packages/cli/src/sync/plan.ts` (emit the sweep file when any channel enables
  `digest`/`post`).
- Tests across `packages/core` + `packages/cli`; a sample `watch` block in
  `examples/starter`; README/setup notes for the added Slack event subscription + scopes
  (`channels:history`, `reactions:write`, `chat:write`).

## Non-goals (YAGNI)

- No inbound reaction watching (`summonEmoji` dropped for MVP).
- No non-Slack surfaces.
- No external store for MVP (Slack-derived best-effort idempotency/caps).
- No quiet-hours (can add later).
- No proactivity beyond the existing convene machinery (still turn-based, no parallel
  deskmates).

## Risks / open questions

- **Gate quality drives everything.** A too-eager gate spams; a too-shy one is invisible.
  Mitigated by default-`ignore`, the tiered guardrails, and the anti-spam eval. Tune with
  `DESKMATE_GATE_MODEL` and the prompt.
- **Best-effort idempotency.** Near-simultaneous Slack retries could double-dispatch
  before the first post lands. Mitigated by retry-header drop + the pre-engage Slack read;
  hard guarantees need the deferred external store.
- **Cost on busy channels.** Every watched message costs one cheap gate call. Keep the
  gate model cheap; opt in deliberately; the cap/cooldown bound the expensive tier.
- **Slack scopes / event subscription** must be added to the Connect trigger destination;
  without them the watcher receives nothing or cannot react. Documented in setup.
