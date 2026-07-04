# Proactive channel watching — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Let deskmates proactively watch opted-in Slack channels and act with three gestures — add a topic-appropriate emoji reaction, drop a thread answer, or make a top-level post — behind a cheap LLM gate and tiered guardrails.

**Architecture:** A two-tier watcher (generalize `slack-ambient.ts`). Tier 1 is a cheap LLM "action selector" that classifies each watched message → `ignore | react | reply | post`; `react` fires `reactions.add` inline (no agent turn); `reply`/`post` dispatch a full front-desk turn exactly as ambient does today. Opt-in and tiering live in a new `watch` block on each channel route, threaded through `defineTeam` → `deskmate sync` codegen. A scheduled sweep (Phase 2) reuses the same dispatch for digests.

**Tech Stack:** TypeScript (NodeNext), zod v4, the `ai` SDK (`generateObject`), eve `defineChannel`/`defineSchedule`, Vitest. pnpm monorepo (`@deskmate/core` + the `deskmate` CLI).

**Design doc:** `docs/plans/2026-07-04-proactive-watching-design.md`

**Reference skills:** @superpowers-extended-cc:test-driven-development, @superpowers-extended-cc:verification-before-completion

---

## Conventions (read once)

- **Run one core test file:** `cd packages/core && npx vitest run test/<file>.test.ts`
- **Run one CLI test file:** `cd packages/cli && npx vitest run test/<file>.test.ts`
- **Full baseline (repo root):** `pnpm -r test && pnpm -r typecheck && pnpm build:packages`
- Tests import source via NodeNext `.js` specifiers (e.g. `from "../src/channel-routes.js"`).
- Renderers are **pure string functions**; values are `JSON.stringify`'d; tests assert with `.toContain(...)`. Sync output must stay **byte-deterministic** (idempotency test depends on it).
- Commit after each task with a `feat(core|cli):` / `test:` scope, matching the existing history.

## Reconciliation note (behavior change — call out in the PR)

Today's ambient channel replies in **any** thread the bot has already joined, with no opt-in. This plan makes proactivity **opt-in per channel** (design decision). After this change, a channel gets proactive behavior only if its route carries a `watch` block. Existing users who relied on ambient joined-thread replies add `watch: { reply: true }` to that channel. This is intentional and aligns with the approved "explicit opt-in" decision; note it in the changelog/PR body.

---

# PHASE 1 — Event-driven watcher

## Task 0: Add the `watch` block to the core `ChannelRoute` type

**Files:**
- Modify: `packages/core/src/channel-routes.ts` (add `ChannelWatch` type + field)
- Test: `packages/core/test/channel-routes.test.ts`

**Step 1: Write the failing test** — append to `channel-routes.test.ts`:

```ts
import type { ChannelRoute } from "../src/channel-routes.js";

describe("ChannelRoute.watch type", () => {
  it("accepts a route with a watch block", () => {
    const route: ChannelRoute = {
      deskmate: "devops",
      watch: { react: true, reply: true, post: false, picker: "routed" },
    };
    expect(route.watch?.picker).toBe("routed");
  });
});
```

**Step 2: Run — expect FAIL** (`watch` not on the type): `cd packages/core && npx vitest run test/channel-routes.test.ts`

**Step 3: Implement** — in `channel-routes.ts`, add above `ChannelRoute`:

```ts
export type ChannelWatch = {
  react?: boolean;                       // Tier-1 emoji reactions (default true)
  reply?: boolean;                       // Tier-2 thread answers (default true)
  post?: boolean;                        // Tier-2 top-level posts (default false)
  approvePosts?: boolean;                // HITL approve/reject before a post (default false)
  picker?: "routed" | "frontdesk";       // who acts (default "routed")
  reactionPalette?: string[];            // allowed reaction emoji (curated default otherwise)
  digest?: boolean;                      // include in the scheduled sweep (Phase 2)
};
```

Then extend the type: `export type ChannelRoute = { deskmate: string; lock?: boolean; watch?: ChannelWatch };`

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git add -A && git commit -m "feat(core): add optional watch block to ChannelRoute"`

---

## Task 1: `resolveWatch` — effective watch settings + env overrides

**Files:**
- Modify: `packages/core/src/channel-routes.ts` (add `resolveWatch`, `watchDisabled`, `DEFAULT_REACTION_PALETTE`)
- Modify: `packages/core/src/index.ts` (export them)
- Test: `packages/core/test/channel-routes.test.ts`

**Step 1: Write failing tests:**

```ts
import { resolveWatch, watchDisabled, DEFAULT_REACTION_PALETTE } from "../src/channel-routes.js";

describe("resolveWatch", () => {
  it("returns null when the route has no watch block", () => {
    expect(resolveWatch({ deskmate: "devops" })).toBeNull();
  });
  it("fills defaults for a bare watch block", () => {
    const w = resolveWatch({ deskmate: "devops", watch: {} })!;
    expect(w).toMatchObject({ react: true, reply: true, post: false, approvePosts: false, picker: "routed" });
    expect(w.palette).toEqual(DEFAULT_REACTION_PALETTE);
  });
  it("honors explicit overrides", () => {
    const w = resolveWatch({ deskmate: "devops", watch: { post: true, picker: "frontdesk", reactionPalette: ["eyes"] } })!;
    expect(w.post).toBe(true);
    expect(w.picker).toBe("frontdesk");
    expect(w.palette).toEqual(["eyes"]);
  });
  it("reads cooldown + cap from env with sane defaults", () => {
    const prev = process.env.DESKMATE_REPLY_COOLDOWN_MIN;
    process.env.DESKMATE_REPLY_COOLDOWN_MIN = "30";
    expect(resolveWatch({ deskmate: "x", watch: {} })!.replyCooldownMin).toBe(30);
    if (prev === undefined) delete process.env.DESKMATE_REPLY_COOLDOWN_MIN; else process.env.DESKMATE_REPLY_COOLDOWN_MIN = prev;
  });
});

describe("watchDisabled", () => {
  it("is true only when DESKMATE_WATCH_DISABLED is set non-empty", () => {
    const prev = process.env.DESKMATE_WATCH_DISABLED;
    delete process.env.DESKMATE_WATCH_DISABLED; expect(watchDisabled()).toBe(false);
    process.env.DESKMATE_WATCH_DISABLED = "1"; expect(watchDisabled()).toBe(true);
    if (prev === undefined) delete process.env.DESKMATE_WATCH_DISABLED; else process.env.DESKMATE_WATCH_DISABLED = prev;
  });
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** in `channel-routes.ts`:

```ts
export const DEFAULT_REACTION_PALETTE = ["eyes", "white_check_mark", "tada", "warning", "+1"];

export type EffectiveWatch = {
  react: boolean; reply: boolean; post: boolean; approvePosts: boolean;
  picker: "routed" | "frontdesk"; palette: string[];
  replyCooldownMin: number; postDailyCap: number;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** True when the whole watch layer is switched off by ops. */
export function watchDisabled(): boolean {
  return !!process.env.DESKMATE_WATCH_DISABLED;
}

/** Effective, defaulted watch settings for a route, or null when the channel isn't watched. */
export function resolveWatch(route: ChannelRoute | null | undefined): EffectiveWatch | null {
  const w = route?.watch;
  if (!w) return null;
  return {
    react: w.react ?? true,
    reply: w.reply ?? true,
    post: w.post ?? false,
    approvePosts: w.approvePosts ?? false,
    picker: w.picker ?? "routed",
    palette: w.reactionPalette ?? DEFAULT_REACTION_PALETTE,
    replyCooldownMin: numEnv("DESKMATE_REPLY_COOLDOWN_MIN", 10),
    postDailyCap: numEnv("DESKMATE_POST_DAILY_CAP", 3),
  };
}
```

Add to `index.ts` exports: `resolveWatch`, `watchDisabled`, `DEFAULT_REACTION_PALETTE`, and `type ChannelWatch, type EffectiveWatch`.

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git commit -am "feat(core): resolveWatch effective settings + env overrides"`

---

## Task 2: `clampVerdict` — the pure gate-decision guardrail

**Files:**
- Create: `packages/core/src/watch-gate.ts`
- Test: `packages/core/test/watch-gate.test.ts`

This is the safety heart: whatever the model says, `clampVerdict` forces it back inside the channel's allowed actions + palette. Default is always `ignore`.

**Step 1: Write failing tests** (`test/watch-gate.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { clampVerdict, type WatchToggles } from "../src/watch-gate.js";

const toggles: WatchToggles = { react: true, reply: true, post: true, palette: ["eyes", "tada"] };

describe("clampVerdict", () => {
  it("passes a valid react with an in-palette emoji (strips colons)", () => {
    expect(clampVerdict({ action: "react", emoji: ":eyes:" }, toggles)).toEqual({ action: "react", emoji: "eyes", reason: undefined });
  });
  it("downgrades a react with an out-of-palette emoji to ignore", () => {
    expect(clampVerdict({ action: "react", emoji: "fire" }, toggles).action).toBe("ignore");
  });
  it("downgrades react to ignore when react is disabled", () => {
    expect(clampVerdict({ action: "react", emoji: "eyes" }, { ...toggles, react: false }).action).toBe("ignore");
  });
  it("downgrades post to ignore when post is disabled", () => {
    expect(clampVerdict({ action: "post" }, { ...toggles, post: false }).action).toBe("ignore");
  });
  it("passes reply and post when enabled", () => {
    expect(clampVerdict({ action: "reply" }, toggles).action).toBe("reply");
    expect(clampVerdict({ action: "post" }, toggles).action).toBe("post");
  });
  it("treats an unknown action as ignore", () => {
    expect(clampVerdict({ action: "banana" as any }, toggles).action).toBe("ignore");
  });
});
```

**Step 2: Run — expect FAIL** (module missing).

**Step 3: Implement** (`packages/core/src/watch-gate.ts`):

```ts
export type WatchAction = "ignore" | "react" | "reply" | "post";
export type WatchVerdict = { action: WatchAction; emoji?: string; reason?: string };
export type WatchToggles = { react: boolean; reply: boolean; post: boolean; palette: string[] };

/** Force a raw model verdict back inside what the channel allows. Default: ignore. */
export function clampVerdict(raw: WatchVerdict, t: WatchToggles): WatchVerdict {
  const reason = raw.reason;
  switch (raw.action) {
    case "react": {
      const emoji = (raw.emoji ?? "").replace(/:/g, "").trim();
      if (!t.react || !emoji || !t.palette.includes(emoji)) return { action: "ignore", reason };
      return { action: "react", emoji, reason };
    }
    case "reply":
      return t.reply ? { action: "reply", reason } : { action: "ignore", reason };
    case "post":
      return t.post ? { action: "post", reason } : { action: "ignore", reason };
    default:
      return { action: "ignore", reason };
  }
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git commit -am "feat(core): clampVerdict guardrail for the watch gate"`

---

## Task 3: `classifyEvent` — the cheap LLM action selector

**Files:**
- Modify: `packages/core/src/watch-gate.ts` (add `classifyEvent` + prompt builder + palette-meaning map)
- Test: `packages/core/test/watch-gate.test.ts`

`classifyEvent` takes an **injectable** `generate` fn so tests never call a real model.

**Step 1: Write failing tests:**

```ts
import { classifyEvent } from "../src/watch-gate.js";

describe("classifyEvent", () => {
  const toggles = { react: true, reply: true, post: false, palette: ["eyes"] };
  const fakeGen = (object: any) => (async () => ({ object })) as any;

  it("returns the model verdict, clamped", async () => {
    const v = await classifyEvent({ text: "prod is down", recent: "", toggles, generate: fakeGen({ action: "reply", reason: "incident" }) });
    expect(v.action).toBe("reply");
  });
  it("clamps a disabled action to ignore", async () => {
    const v = await classifyEvent({ text: "ship it", recent: "", toggles, generate: fakeGen({ action: "post" }) });
    expect(v.action).toBe("ignore");
  });
  it("fails closed to ignore when the model throws", async () => {
    const boom = (async () => { throw new Error("model down"); }) as any;
    const v = await classifyEvent({ text: "x", recent: "", toggles, generate: boom });
    expect(v.action).toBe("ignore");
  });
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** — add to `watch-gate.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";

const VerdictSchema = z.object({
  action: z.enum(["ignore", "react", "reply", "post"]),
  emoji: z.string().optional(),
  reason: z.string().optional(),
});

// The cheap default gate model. Fires on every watched message, so keep it cheap.
// NOTE: verify this id resolves on the Vercel AI Gateway; override with DESKMATE_GATE_MODEL.
const DEFAULT_GATE_MODEL = "anthropic/claude-haiku-4.5";

/** What each palette emoji means, so the gate picks the right one. Unknown emoji get a generic hint. */
function paletteGuide(palette: string[]): string {
  const meaning: Record<string, string> = {
    eyes: "I'm looking into this / picking it up",
    white_check_mark: "done / confirmed / resolved",
    tada: "a genuine win, launch, or milestone",
    warning: "a risk or something to be careful about",
    "+1": "a plain acknowledgement / agreement",
  };
  return palette.map((e) => `:${e}: = ${meaning[e] ?? "use only when clearly relevant to the topic"}`).join("\n");
}

export function buildGatePrompt(input: { text: string; recent: string; toggles: WatchToggles }): string {
  const { text, recent, toggles } = input;
  const allowed = [
    "ignore (default — pick this unless there's a clear reason not to)",
    toggles.react ? "react (add ONE emoji from the palette below, only when it genuinely fits)" : null,
    toggles.reply ? "reply (write a threaded answer — only if you can actually help)" : null,
    toggles.post ? "post (a new top-level message — reserve for something clearly worth interrupting the channel)" : null,
  ].filter(Boolean).join("\n- ");
  return (
    "You are the attention gate for an AI teammate watching a Slack channel. " +
    "Decide the SINGLE best action for the new message. Bias hard toward `ignore`; " +
    "human-to-human chatter, acknowledgements, and anything not for the teammate → ignore.\n\n" +
    `Allowed actions:\n- ${allowed}\n\n` +
    `Reaction palette (emoji name → meaning):\n${paletteGuide(toggles.palette)}\n\n` +
    `Recent context:\n${recent || "(none)"}\n\nNew message: ${text}\n\n` +
    "Return the action, an emoji (name only, if action is react), and a one-line reason."
  );
}

export async function classifyEvent(input: {
  text: string;
  recent: string;
  toggles: WatchToggles;
  model?: string;
  generate?: typeof generateObject;
}): Promise<WatchVerdict> {
  const gen = input.generate ?? generateObject;
  const model = input.model ?? process.env.DESKMATE_GATE_MODEL ?? DEFAULT_GATE_MODEL;
  try {
    const { object } = await gen({ model, schema: VerdictSchema, prompt: buildGatePrompt(input) } as any);
    return clampVerdict(object as WatchVerdict, input.toggles);
  } catch {
    return { action: "ignore", reason: "gate error" };
  }
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git commit -am "feat(core): classifyEvent LLM action selector (injectable, fails closed)"`

---

## Task 4: Reply-cooldown helper (Slack-derived, pure)

**Files:**
- Create: `packages/core/src/channels/watch-cooldown.ts`
- Test: `packages/core/test/watch-cooldown.test.ts`

**Step 1: Write failing tests:**

```ts
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
    // now = 1500 + 5min*60 - 1s → still inside a 10-min window
    expect(withinCooldown(replies, BOT, 1500 + 5 * 60, 10)).toBe(true);
  });
  it("is NOT within cooldown after the window passes", () => {
    expect(withinCooldown(replies, BOT, 1500 + 11 * 60, 10)).toBe(false);
  });
  it("is never within cooldown when the bot hasn't posted", () => {
    expect(withinCooldown(replies, "U_OTHER", 9999, 10)).toBe(false);
  });
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** (`watch-cooldown.ts`):

```ts
type Msg = { user?: string; ts?: string; bot_id?: string };

/** The bot's most recent message time (float seconds) in a thread, or null. */
export function lastBotReplySec(messages: Msg[], botUserId: string): number | null {
  let latest: number | null = null;
  for (const m of messages) {
    if (m.user !== botUserId || !m.ts) continue;
    const sec = Number.parseFloat(m.ts);
    if (Number.isFinite(sec) && (latest === null || sec > latest)) latest = sec;
  }
  return latest;
}

/** True if the bot posted in this thread within `minutes` of `nowSec`. */
export function withinCooldown(messages: Msg[], botUserId: string, nowSec: number, minutes: number): boolean {
  const last = lastBotReplySec(messages, botUserId);
  if (last === null) return false;
  return nowSec - last < minutes * 60;
}
```

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git commit -am "feat(core): Slack-derived reply-cooldown helpers"`

---

## Task 5: Generalize the ambient channel into the watcher

**Files:**
- Modify: `packages/core/src/channels/slack-ambient.ts`
- Manual/sandbox verification (the handler is I/O-heavy; unit coverage lives in Tasks 1–4).

This is the wiring task. Keep the route path `/eve/v1/slack-ambient` (no re-provisioning) and the existing verify/dedupe/`slackApi`/`getBotUserId` helpers. Change the decision from binary to the action selector, add top-level-message handling, inline reactions, and the cooldown/opt-in checks.

**Step 1** — add a helper next to `slackApi`:

```ts
async function addReaction(channelId: string, ts: string, name: string): Promise<void> {
  const r = await slackApi("reactions.add", { channel: channelId, timestamp: ts, name });
  if (!r?.ok && r?.error !== "already_reacted") log(`reactions.add ${name} error:`, r?.error);
}
```

**Step 2** — in the `waitUntil` body, replace the "must have joined the thread + binary gate" logic with:

```ts
// Opt-in gate: only watched channels do anything.
if (watchDisabled()) return log("skip: DESKMATE_WATCH_DISABLED");
const route = resolveRoute({ id: channelId }, routes);
const watch = resolveWatch(route);
if (!route || !watch) return log("skip: channel not opted into watch");

const botUserId = await getBotUserId();
if (!botUserId) return log("skip: no botUserId");
if (userId === botUserId) return log("skip: bot's own message");
if (text.includes(`<@${botUserId}>`)) return log("skip: @mention → managed channel handles it");

// Thread context (also used for the reply cooldown). For a top-level message, threadTs = event.ts.
const rootTs = threadTs ?? event.ts;
const { recent, messages } = await threadContext(channelId, rootTs, botUserId); // conversations.replies, tolerant of a 1-message thread

const verdict = await classifyEvent({
  text,
  recent,
  toggles: { react: watch.react, reply: watch.reply, post: watch.post, palette: watch.palette },
});
log(`verdict: ${verdict.action}${verdict.emoji ? " :" + verdict.emoji + ":" : ""} — ${verdict.reason ?? ""}`);

if (verdict.action === "ignore") return;

if (verdict.action === "react" && verdict.emoji) {
  await addReaction(channelId, event.ts, verdict.emoji); // react on the specific message
  return;
}

// reply | post → Tier 2. Cooldown applies to replies in an existing thread.
if (verdict.action === "reply" && withinCooldown(messages, botUserId, Number.parseFloat(event.ts), watch.replyCooldownMin)) {
  return log("skip: within reply cooldown");
}
// (post daily-cap check: read conversations.history for the bot's own top-level posts in 24h — implement here.)

const directive =
  watch.picker === "routed"
    ? `[routing] This Slack channel maps to the \`${route.deskmate}\` deskmate. You are proactively engaging (no one @mentioned you). Delegate to \`${route.deskmate}\`.`
    : `[routing] You are proactively engaging in this channel (no one @mentioned you). Pick the best-matching deskmate by domain.`;

await args.receive(slack, {
  message: `[proactive:${verdict.action}] ${text}`,
  target: verdict.action === "reply" ? { channelId, threadTs: rootTs } : { channelId },
  context: [directive],
  auth: { authenticator: "slack", issuer: "slack", principalType: "user", principalId: userId, subject: userId, attributes: { teamId: envelope?.team_id ?? null, channelId } },
});
```

**Step 3** — drop the old early-returns that required `threadTs` and `threadTs !== event.ts` (top-level messages are now valid). Keep dedupe (`rememberEvent`), the retry-header drop (add `if (req.headers.get("x-slack-retry-num")) return new Response("ok")` early), and `subtype`/`bot_id` filtering.

**Step 4** — extract `threadContext(channelId, ts, botUserId)` from the existing `deskmateInThread` (return `{ recent, messages }`; it already calls `conversations.replies`). Imports to add at top: `resolveWatch, watchDisabled` from `../channel-routes.js`, `classifyEvent` from `../watch-gate.js`, `withinCooldown` from `./watch-cooldown.js`.

**Step 5: Typecheck + run the core suite:**

`cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: PASS (unit suites from Tasks 0–4 stay green; the channel compiles).

**Step 6: Commit:** `git commit -am "feat(core): generalize the ambient channel into the two-tier watcher"`

> Verification for this task is the **sandbox integration** in Task 10 (post a message in an opted-in channel → observe a react or a threaded reply). Do not claim it works from typecheck alone — see @superpowers-extended-cc:verification-before-completion.

---

## Task 6: Serialize `watch` in the generated channel routes

**Files:**
- Modify: `packages/cli/src/sync/render.ts` (`renderChannelRoutes`)
- Test: `packages/cli/test/render.test.ts`

**Step 1: Write failing test** — add to the `renderChannelRoutes` describe:

```ts
it("serializes the watch block deterministically", () => {
  const team = {
    ...fixtureTeam,
    channels: { C0INC: { deskmate: "devops", lock: true, watch: { react: true, reply: true, post: false, picker: "routed" } } },
  } as unknown as TeamConfig;
  const out = renderChannelRoutes(team);
  expect(out).toContain('"C0INC": {"deskmate":"devops","lock":true,"watch":{"react":true,"reply":true,"post":false,"picker":"routed"}}');
});

it("omits watch when the route has none", () => {
  const team = { ...fixtureTeam, channels: { C0G: { deskmate: "product_analyst" } } } as unknown as TeamConfig;
  expect(renderChannelRoutes(team)).toContain('"C0G": {"deskmate":"product_analyst"}');
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** — in `renderChannelRoutes`, extend the value builder:

```ts
const value: ChannelRoute = { deskmate: route.deskmate };
if (route.lock !== undefined) value.lock = route.lock;
if (route.watch !== undefined) value.watch = route.watch;
return `  ${JSON.stringify(channel)}: ${JSON.stringify(value)},`;
```

(Property order stays `deskmate, lock, watch` for deterministic output. Ensure `ChannelRoute` imported into render.ts already covers `watch` via the core type from Task 0.)

**Step 4: Run — expect PASS. Also run the idempotency test:** `cd packages/cli && npx vitest run test/sync.test.ts`

**Step 5: Commit:** `git commit -am "feat(cli): sync serializes the channel watch block"`

---

## Task 7: Add `watch` to the config schema (zod)

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/test/config.test.ts`

**Step 1: Write failing tests:**

```ts
it("parses a channel watch block with defaults", () => {
  const team = defineTeam({
    deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
    channels: { C0INC: { deskmate: "devops", watch: {} } },
  });
  expect(team.channels.C0INC.watch).toMatchObject({ react: true, reply: true, post: false, approvePosts: false, picker: "routed" });
});

it("rejects an unknown picker", () => {
  expect(() => defineTeam({
    deskmates: { devops: { role: "devops", emoji: ":x:", displayName: "D", summary: "s" } },
    channels: { C0INC: { deskmate: "devops", watch: { picker: "nope" } } },
  })).toThrow();
});
```

(Confirm the exact minimal deskmate shape against the existing `config.test.ts` fixtures and match it.)

**Step 2: Run — expect FAIL.**

**Step 3: Implement** — in `config.ts`, add before `ChannelRoute`:

```ts
const ChannelWatch = z.object({
  react: z.boolean().default(true),
  reply: z.boolean().default(true),
  post: z.boolean().default(false),
  approvePosts: z.boolean().default(false),
  picker: z.enum(["routed", "frontdesk"]).default("routed"),
  reactionPalette: z.array(z.string()).nonempty().optional(),
  digest: z.boolean().optional(),
});
```

Extend the route schema: `const ChannelRoute = z.object({ deskmate: z.string(), lock: z.boolean().optional(), watch: ChannelWatch.optional() });`

(`watch` stays `.optional()` — when present, zod parses the object and applies the inner `.default()`s; when absent it's `undefined`. Do NOT use `.default({})`, which would not re-parse — same gotcha as `frontDesk`.)

**Step 4: Run — expect PASS.** Then `cd packages/core && npx vitest run` (whole suite green).

**Step 5: Commit:** `git commit -am "feat(core): validate the channel watch block in defineTeam"`

---

## Task 8: Anti-spam eval + Phase-1 green baseline

**Files:**
- Create: `packages/core/test/watch-gate.eval.test.ts`
- Run the full baseline.

**Step 1: Write the eval** (deterministic — stub the model with canned verdicts, assert the gate honors `ignore` and never posts outside the palette). This guards the guardrail wiring, not model quality:

```ts
import { describe, it, expect } from "vitest";
import { clampVerdict } from "../src/watch-gate.js";

const chatter = [
  { action: "react", emoji: "fire" },      // out of palette → ignore
  { action: "post" },                       // post disabled → ignore
  { action: "reply" },                      // reply disabled → ignore
];

describe("anti-spam: disabled/invalid actions collapse to ignore", () => {
  const quiet = { react: true, reply: false, post: false, palette: ["eyes"] };
  it("keeps a read-only channel silent", () => {
    for (const raw of chatter) expect(clampVerdict(raw as any, quiet).action).toBe("ignore");
  });
});
```

**Step 2: Run — expect PASS.**

**Step 3: Full baseline (repo root):**

`pnpm -r test && pnpm -r typecheck && pnpm build:packages`
Expected: all green.

**Step 4: Commit:** `git commit -am "test(core): anti-spam guardrail eval; phase-1 green"`

---

# PHASE 2 — Scheduled sweep (digests / catch-ups)

## Task 9: `createDeskmateSweep` factory + team-level `sweep` cadence

**Files:**
- Create: `packages/core/src/schedules/deskmate-sweep.ts`
- Modify: `packages/core/src/config.ts` (add team-level `sweep: { cron }`)
- Modify: `packages/core/src/index.ts` (export `createDeskmateSweep`)
- Test: `packages/core/test/deskmate-sweep.test.ts`

**Step 1: Write failing tests** — the sweep's channel selection + per-channel message building are pure and testable with an injected `receive`:

```ts
import { describe, it, expect } from "vitest";
import { sweepTargets } from "../src/schedules/deskmate-sweep.js";

const routes = {
  C0A: { deskmate: "devops", watch: { digest: true } },
  C0B: { deskmate: "growth_hacker", watch: { reply: true } }, // no digest
  C0C: { deskmate: "devops" },                                 // not watched
};

describe("sweepTargets", () => {
  it("selects only channels with watch.digest", () => {
    expect(sweepTargets(routes).map((t) => t.channelId)).toEqual(["C0A"]);
  });
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement** (`deskmate-sweep.ts`):

```ts
import { defineSchedule } from "eve/schedules";
import type { ChannelRoute } from "../channel-routes.js";
import type { Roster } from "../roster.js";

export const DEFAULT_SWEEP_CRON = "0 9 * * 1-5";

export type SweepTarget = { channelId: string; deskmate: string };

/** Channels opted into the scheduled sweep (watch.digest === true). */
export function sweepTargets(routes: Record<string, ChannelRoute>): SweepTarget[] {
  return Object.entries(routes)
    .filter(([, r]) => r.watch?.digest === true)
    .map(([channelId, r]) => ({ channelId, deskmate: r.deskmate }));
}

export function createDeskmateSweep(
  roster: Roster,
  routes: Record<string, ChannelRoute>,
  opts: { cron?: string; slack: unknown } // pass the built managed slack channel
) {
  const targets = sweepTargets(routes);
  return defineSchedule({
    cron: opts.cron ?? DEFAULT_SWEEP_CRON,
    async run({ receive, waitUntil, appAuth }) {
      for (const t of targets) {
        waitUntil(
          receive(opts.slack as any, {
            message:
              `[proactive:sweep] Review recent activity in this channel. ` +
              `Post a short update or react ONLY if something genuinely warrants it; otherwise finish silently.`,
            target: { channelId: t.channelId },
            auth: appAuth,
          })
        );
      }
    },
  });
}
```

(Confirm `defineSchedule`'s handler arg names against `node_modules/eve/docs/schedules.mdx` — `receive`, `waitUntil`, `appAuth`.)

Add `sweep: z.object({ cron: z.string() }).optional()` to `TeamConfig` in `config.ts`. Export `createDeskmateSweep` + `DEFAULT_SWEEP_CRON` from `index.ts`.

**Step 4: Run — expect PASS.**

**Step 5: Commit:** `git commit -am "feat(core): createDeskmateSweep schedule factory"`

---

## Task 10: Generate the sweep schedule in sync (conditional)

**Files:**
- Modify: `packages/cli/src/sync/render.ts` (add `renderDeskmateSweepSchedule`)
- Modify: `packages/cli/src/sync/plan.ts` (emit it only when a channel opts into `digest`)
- Test: `packages/cli/test/render.test.ts`, `packages/cli/test/plan.test.ts`

**Step 1: Write failing tests:**

`render.test.ts`:
```ts
it("renders a sweep schedule that calls createDeskmateSweep", () => {
  const out = renderDeskmateSweepSchedule({ ...fixtureTeam, sweep: { cron: "0 8 * * 1-5" } } as any);
  expect(out).toContain('import { createDeskmateSweep } from "@deskmate/core";');
  expect(out).toContain('import slack from "../channels/slack.js";');
  expect(out).toContain('"0 8 * * 1-5"');
});
```

`plan.test.ts` (match the existing plan-test style — assert on `writes` paths):
```ts
it("emits the sweep schedule only when a channel opts into digest", () => {
  const withDigest = { ...baseTeam, channels: { C0A: { deskmate: "devops", watch: { digest: true } } } };
  const plan = planSync(withDigest as any, "/tmp/x");
  expect(plan.writes.some((w) => w.path.endsWith("agent/schedules/deskmate-sweep.ts"))).toBe(true);

  const noDigest = { ...baseTeam, channels: {} };
  const plan2 = planSync(noDigest as any, "/tmp/x");
  expect(plan2.writes.some((w) => w.path.endsWith("agent/schedules/deskmate-sweep.ts"))).toBe(false);
});
```

**Step 2: Run — expect FAIL.**

**Step 3: Implement.**

`render.ts`:
```ts
export function renderDeskmateSweepSchedule(team: TeamConfig): string {
  const cron = team.sweep?.cron ?? "0 9 * * 1-5";
  return `${BANNER}
import { createDeskmateSweep } from "@deskmate/core";
import { DESKMATES } from "../lib/deskmates.js";
import { CHANNEL_ROUTES } from "../lib/channel-routes.js";
import slack from "../channels/slack.js";

export default createDeskmateSweep(DESKMATES, CHANNEL_ROUTES, { cron: ${JSON.stringify(cron)}, slack });
`;
}
```

`plan.ts` — after the root-files block:
```ts
if (Object.values(team.channels).some((r) => r.watch?.digest === true)) {
  out("agent/schedules/deskmate-sweep.ts", renderDeskmateSweepSchedule(team));
}
```

**Step 4: Run — expect PASS.** Re-run the sync idempotency test: `cd packages/cli && npx vitest run test/sync.test.ts`

**Step 5: Commit:** `git commit -am "feat(cli): generate the sweep schedule when a channel opts into digest"`

---

# WRAP-UP

## Task 11: Starter example, docs, and full verification

**Files:**
- Modify: `examples/starter/deskmate.config.ts` (a commented example `watch` block)
- Modify: `README.md` (a "Proactive watching" section: opt-in config, the added Slack event subscription for `message.channels`, and scopes `channels:history`, `reactions:write`, `chat:write`)
- Modify: `CHANGELOG.md` / PR body (note the opt-in behavior change from the Reconciliation note)

**Step 1** — add to the starter config `channels` a commented, copy-pasteable example:

```ts
channels: {
  // Proactively watch an incidents channel: DevOps reacts + answers in-thread, no top-level posts.
  // "C0123INCIDENTS": {
  //   deskmate: "devops",
  //   watch: { react: true, reply: true, post: false, picker: "routed" },
  // },
},
```

**Step 2** — README section documenting: the `watch` block and each field; that watching is opt-in; the Slack app changes (subscribe `message.channels`; add `reactions:write`); env knobs (`DESKMATE_GATE_MODEL`, `DESKMATE_WATCH_DISABLED`, `DESKMATE_REPLY_COOLDOWN_MIN`, `DESKMATE_POST_DAILY_CAP`, `sweep.cron`).

**Step 3 — Full green baseline:** `pnpm -r test && pnpm -r typecheck && pnpm build:packages` → all green.

**Step 4 — Sandbox integration verification** (per @superpowers-extended-cc:verification-before-completion — do this, don't skip):
- In a test workspace, opt a channel into `watch`, run `deskmate sync`, deploy/`eve dev` + dispatch, and confirm: (a) an on-topic message gets a threaded reply; (b) a clearly-relevant message gets a single palette reaction; (c) chatter is ignored; (d) a rapid second message inside the cooldown does not double-reply; (e) with `post:false`, no top-level posts appear.
- Capture the observed behavior in the PR description.

**Step 5: Commit:** `git commit -am "docs: proactive watching setup + starter example; changelog note"`

---

## Definition of done

- All unit suites green; `pnpm -r typecheck` clean; `pnpm build:packages` succeeds.
- `deskmate sync` output is deterministic (idempotency test passes) and includes the `watch` block + the conditional sweep schedule.
- Sandbox run demonstrates react / reply / ignore / cooldown / post-gated behavior.
- README + starter document opt-in, scopes, and env knobs; the opt-in behavior change is noted in the changelog/PR.
