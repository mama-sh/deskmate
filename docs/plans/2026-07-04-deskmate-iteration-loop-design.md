# Deskmate voice + iteration-loop upgrade

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan

## Problem

When people summon a deskmate by tagging `@deskmate` on Slack, the replies read as
AI-generated rather than as a message from a real coworker, and the interaction loop
is thin. Four things to improve (all approved by the user):

1. **Multi-turn conversation** — follow-ups in a thread feel like talking to a stranger.
2. **Answer quality per turn** — thoroughness and grounding.
3. **Progress visibility** — what the user sees while a deskmate works.
4. **Output voice (the biggest one)** — the answer should read like a real employee wrote it, not an AI.

## Diagnosis

- The per-role `instructions.md` files are tiny and **say nothing about voice**, so the
  model answers in its factory register: bullet-point-itis, `**Label:** …` inline-header
  lists, rule-of-three, em-dash overuse, promotional adjectives, hedging, "Here's what I
  found," and generic upbeat closers. Nothing in the pipeline pushes back on any of it.
- **Continuity:** a deskmate subagent never sees the thread — the front desk repacks
  context each turn, and nothing tells it to route a follow-up back to the *same* deskmate
  with the prior exchange. (The front desk *does* see thread history as the root session.)
- **Answer quality:** instructions say "gather facts" but never "ask a clarifying question
  when the ask is ambiguous instead of guessing" — the single highest-trust habit
  (one study: repeat-corrections dropped from ~4 to 1.3 per task after adding one
  clarifying question).
- **Progress:** eve already posts `Thinking…/Working…/tool status`. Generic, but present —
  this is the smallest gap.

**Key realization:** ~80% of all four problems is prompt/instruction engineering, not new
machinery. A shared house-style voice block is the single highest-leverage change.

## Architecture context (how the pieces fit today)

- `@deskmate` mention → eve Slack channel `onAppMention` (`packages/core/src/channels/slack.ts`)
  injects a `[routing]` directive and starts/resumes a durable session anchored to the thread.
- A **front-desk router** (`packages/core/src/front-desk-instructions.md`) delegates once to
  the matching **subagent** (a "deskmate"). The subagent never sees the thread; the front
  desk packs everything into `message`.
- `deskmate sync` codegen (`packages/cli/src/sync/`): front-desk prose comes from core's
  `front-desk-instructions.md` (`render.ts:renderFrontDeskInstructions`); **subagent
  instructions are the role's `instructions.md` copied VERBATIM** (`plan.ts:114`). So a
  shared voice block belongs in **core**, composed into each deskmate's instructions at
  sync time.

## Approach

Instructions-first (lean). The "humanize pass" is baked **into the prompt** ("reread and
strip AI-slop before sending") so it happens inside the single turn — no extra model call,
no added latency (which matters because responsiveness is one of the goals). Durable
structural continuity is deferred until we see whether instructions alone land.

## Components

### 1. Shared "house style" voice block (the big one)

- **New:** `packages/core/src/house-style.md` + `house-style.ts` exporting the string
  (mirrors `front-desk-instructions.ts`).
- `deskmate sync` composes it under each deskmate's role instructions when writing
  `agent/subagents/<id>/instructions.md`, and appends a short version to the front desk.
- Authored once in core; consumers keep editing role-specific `roles/<id>/instructions.md`.

Block content (approved draft):

> ## How you write
> You're a coworker dropping a message in Slack, not an AI assistant writing a report.
> Write like a sharp colleague who's busy but helpful.
>
> - **Lead with the answer.** First line = the punchline. No "Here's what I found," no
>   "Great question," no restating their question back.
> - **Keep it short.** A Slack message, not an essay. Most answers are 1–4 sentences. Add
>   detail only if it changes what they'd do next.
> - **Prose over bullets.** Only use a list for genuinely list-shaped data (3+ parallel
>   items). Never write `**Label:** text` inline-header lists — the #1 tell of AI writing.
> - **Plain punctuation.** Commas and periods, not em-dashes. Straight quotes. Bold at most
>   one thing, and only if it's a number or name that matters.
> - **Talk like a person.** First person. Have a view ("I'd hold off on that"). Say when
>   you're unsure ("not certain yet — still digging"). Vary your sentence length.
> - **Cut the AI tells.** Never use: delve, leverage (verb), robust, seamless, crucial,
>   pivotal, underscore, foster, "it's not just X, it's Y," "from X to Y," or a generic
>   upbeat closer. No "let me know if you need anything else" — offer a *specific* next
>   step or just stop.
> - **Before you send, reread your draft and delete anything that sounds like a machine wrote it.**

### 2. Per-deskmate `voice` field (cheap persona)

- Add optional `voice?: string` to `DeskmateConfig` (`packages/core/src/config.ts`).
- One line per deskmate, injected right under the house style so they don't sound identical.
  Example (devops): *"Terse SRE. Leads with the punchline, shows the query he ran, flags
  risk plainly. Dry, not chatty."*
- Omit it → just the house style. Zero migration cost.

### 3. Loop-discipline rules (answer quality + continuity)

Instruction-level, no new machinery:

- **Ask, don't guess** (shared block): "If the request is ambiguous or missing a detail you
  can't infer, ask ONE sharp clarifying question instead of guessing." Uses eve's built-in
  `ask_question` HITL tool → renders in the Slack thread.
- **Ground every claim** (shared block): "Every number comes from a tool result. Show the
  source briefly. Never state a figure you didn't pull."
- **Follow-up continuity** (`front-desk-instructions.md`): "If this thread was already
  handled by a deskmate and the new message is a follow-up in their domain, delegate to the
  SAME deskmate and include the earlier exchange in `message`."

### 4. In-voice progress (smallest; deferred)

eve already posts `Thinking…/Working…/tool status`. Routing happens *after* the turn starts,
so we can't voice-as-deskmate at `turn.started`. Leave eve's defaults; optionally soften the
initial indicator text. Defer anything fancier — over-notifying ("status theater") is worse
than a clean "working → answer."

### 5. Guardrail: anti-slop eval

A lightweight eval/test that greps generated or sample replies for banned tells (em-dashes,
`**Label:**` lists, AI-vocab words). Plus unit tests: `voice` field parses; sync composes
house-style into subagent instructions deterministically. The existing byte-exact sync tests
will need updating — injection must stay deterministic so they remain stable.

## Non-goals (YAGNI)

- No second model round-trip / separate humanize pass (kept in-prompt → no latency hit).
- No durable thread→deskmate ownership store (front-desk instruction covers it for now).
- No richer persona objects / few-shot example banks (the `voice` line is enough to start).

## Files touched

- New: `packages/core/src/house-style.md`, `packages/core/src/house-style.ts`
- Edit: `packages/core/src/config.ts` (add `voice`), `packages/core/src/front-desk-instructions.md`
  (continuity rule + short voice note)
- Edit: `packages/cli/src/sync/plan.ts` (compose house-style into subagent instructions),
  possibly `render.ts`
- Tests: update sync render/plan tests; add anti-slop eval; add `voice` schema test
- Catalog: add example `voice` lines to `packages/catalog/roles/*/deskmate.json` (or config)

## Research basis

- Signs of AI writing (humanizer skill / Wikipedia:Signs of AI writing): inline-header lists,
  em-dash overuse, rule-of-three, promotional language, hedging, AI-vocab, sycophancy,
  generic closers — plus "add soul" (opinions, varied rhythm, first person).
- Slack AI UX: acknowledge fast then answer; thread-aware context keyed by thread ts;
  bounded autonomy; don't over-notify.
- Human-sounding output: lower the register explicitly; give style rules; self-refine
  (generate → critique → rewrite), done here in-prompt.
- Answer quality: knowing when to ask a clarifying question is the trust lever; ground
  answers in tool results with visible evidence.
- Progress UX: truth over theater; stream; avoid milestone-ping spam.
