# Multi-deskmate interaction — design

**Date:** 2026-07-02
**Status:** Approved (brainstorming); implementation plan to follow.
**Depends on:** PR #2 (per-deskmate Slack identity) — this feature reuses its
`chat.postMessage` identity path and its `message.completed` delivery override.

## Problem

Today the front desk routes each request to a **single** deskmate and relays one
answer. We want deskmates to **collaborate in the open**: pull each other in when a
request spans domains, tag one another, and respond to each other in the Slack
thread — so the thread reads like a real conversation between coworkers.

Example the user endorsed:

```
user:  why did checkout conversion drop?

📊 Product Analyst:  Conversion fell 12% at the payment step since 09:00.
                     Feels infra-related — cc 🔧 DevOps Engineer, any errors there?

🔧 DevOps Engineer:  Yes — /api/pay timeouts spiked 09:00–09:05. Lines up with your drop.

📊 Product Analyst:  Then the payment timeouts are the cause. Suggested next steps: …
```

## Decisions (from brainstorming)

1. **Interaction model:** *Visible multi-party thread.* Each deskmate posts its own
   message under its own name/avatar and can tag another; the front desk orchestrates
   who speaks next behind the scenes but stays invisible.
2. **Handoff control:** *Hybrid.* The front desk seeds the first responder (and may
   convene an obvious co-owner) based on the request; from then on each deskmate can
   explicitly **tag** another when it needs them, and the orchestrator routes the tag.
3. **Termination:** *Natural end + hard cap.* The loop ends when the latest deskmate
   tags no one and the question is answered; a hard cap on total deskmate turns
   (default ~6, configurable) is the safety net. If capped, the front desk posts a
   brief wrap-up and stops. Each turn is one LLM call, so the cap also bounds cost.
4. **Architecture:** *Approach A — front desk as moderator.* The root already exposes
   every deskmate as a subagent tool; we add a posting tool and a convene loop in the
   root's instructions, rather than a code-owned loop (Approach B) or peer/nested
   subagents (rejected — Eve isolates subagents and they can't post to Slack).

## Eve constraints that shape this

- Subagents are **isolated child sessions**: a deskmate never sees the thread, the
  parent's history, or its sibling deskmates, and **cannot post to Slack** (channels
  are root-only) or call a sibling directly.
- Only the **root** owns the Slack thread. Via PR #2 it can already post *as* any
  deskmate (`chat.postMessage` with `username` + `icon_url`).
- The root packs everything a child needs into the subagent call's `message`; with
  `outputSchema` set, the child runs in **task mode** and returns structured output.

These are why orchestration and all posting live in the **root**, and why context is
**threaded by the root** between deskmates.

## Components (new)

### `deskmate_says(deskmate_id, text)` — `agent/tools/deskmate-says.ts`
Posts one message into the current Slack thread under the given deskmate's identity.
- Resolves the thread (`channelId`, `threadTs`) from the Slack channel's **projected
  metadata** (the channel already surfaces these; extend its `metadata(state)` if
  needed).
- Resolves the deskmate's `username`/`icon_url` via the shared identity resolver
  (extracted from PR #2's `agent/lib/deskmate-identity.ts`) and posts with the
  connector bot token (`connectSlackCredentials`, same as the ambient channel).
- **Enforces the cap:** increments a per-session turn counter in `channel.state`; once
  it reaches `DESKMATE_MAX_TURNS`, it posts nothing further and returns
  `"turn cap reached"` so the model stops looping.
- **Sets `channel.state.convened = true`** so the `message.completed` handler knows the
  turn was already voiced (see Reconciliation).
- Accepts a reserved id (e.g. `"frontdesk"`) for the optional wrap-up, posted under the
  shared "Deskmate" identity.

### Structured deskmate output (no per-deskmate file changes)
When convening, the root calls a deskmate subagent with:
```ts
outputSchema = {
  message: string,                                  // what the deskmate says, verbatim
  tag?: { deskmate: <known id>, ask: string }       // who to pull in next, and why
}
```
and packs into the `message`: the user's request, **relevant context so far** (prior
deskmates' findings), the **roster** (ids + one-line roles, generated from the
`DESKMATES` registry), and the tagging protocol. Because this is all injected by the
root, adding a deskmate needs **no changes here** — the roster updates from the
registry automatically.

### Convene loop — `agent/instructions.md`
```
inbound question
  ├─ single domain            → delegate once, relay  (unchanged PR #2 path)
  └─ cross-domain OR a tag    → CONVENE:
       next = best-match deskmate; ask = user's question
       loop (turns < cap):
         r = delegate(next, message = context + ask + roster + schema)
         deskmate_says(next, r.message)
         if r.tag and r.tag.deskmate is known and not self:
             next = r.tag.deskmate; ask = r.tag.ask; continue
         else: break            # answered
       if capped: deskmate_says("frontdesk", short wrap-up)
```

## Reconciliation with PR #2 (no double-posting)

Two posting modes, one flag:
- **Single-deskmate:** unchanged — the root relays and PR #2's `message.completed`
  handler posts the final message as the active deskmate.
- **Convene:** `deskmate_says` voices every turn and sets `channel.state.convened`. The
  `message.completed` handler **skips posting when `convened` is set** (the whole
  conversation was already posted) and resets the flag.

So a turn is either relayed (single) or tool-voiced (convene) — never both.

## Error handling

- **Cap reached:** `deskmate_says` refuses and signals stop; front desk wraps up.
- **Bad tag** (unknown id or self): ignored; the loop ends.
- **Deskmate subagent error:** the front desk notes it and closes rather than looping.
- **`chat.postMessage` failure:** same fallback as PR #2 — post under the shared bot so
  the content is never dropped.
- **No Slack thread in metadata** (e.g. non-Slack surface): `deskmate_says` no-ops
  gracefully and the root falls back to relaying.

## Testing

- **Unit:** turn-cap enforcement in `deskmate_says`; tag routing (valid / unknown /
  self); the `convened` suppression logic; roster snippet generation from the registry.
- **Green baseline:** `pnpm typecheck`, `pnpm test`, `pnpm build`.
- **Sandbox integration:** a cross-domain question → verify the visible 📊↔🔧 exchange,
  tag routing between deskmates, and that the cap stops a runaway loop.

## Scope guardrails (YAGNI)

- Single-domain questions are **untouched** (no convene overhead).
- Strictly **turn-based** — no parallel/simultaneous deskmates.
- **No persistent memory** between conversations.
- Front desk stays **silent** except an optional wrap-up on cap.
- Applies to both the `@mention` and ambient paths (both dispatch to the root).

## Config

- `DESKMATE_MAX_TURNS` — hard cap on deskmate turns per conversation (default `6`).

## Risks / open questions

- **Prompt-driven routing:** the loop lives in the root's instructions, so routing
  quality depends on the prompt. Mitigated by the code-enforced cap and clear protocol;
  revisit Approach B (code loop) if routing proves unreliable.
- **Context threading:** the root must carry each deskmate's finding into the next
  delegation; if it forgets, a tagged deskmate answers with less context. The output
  schema + explicit instruction to include "context so far" mitigate this.
- **Same face-pile limitation** as PR #2 applies to every posted message.
