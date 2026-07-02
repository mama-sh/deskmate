# Multi-deskmate Interaction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Let deskmates collaborate in the open in a Slack thread — the front desk seeds a responder, deskmates tag each other when needed, and each turn posts under its own name/avatar — bounded by a hard turn cap.

**Architecture:** Approach A (front desk as moderator). The root already exposes every deskmate as a subagent tool. We add a `deskmate_says` tool the root calls to voice a deskmate's message; the **Slack channel's `action.result` handler** does the actual posting under that deskmate's identity (reusing PR #2's `chat.postMessage` path), enforces a per-conversation turn cap via `channel.state`, and suppresses the default single-deskmate post when a convene ran. A convene loop in the root's instructions drives who speaks next.

**Tech Stack:** Vercel Eve (`defineTool`, `slackChannel` events `action.result` / `message.completed`), Zod, Vitest, TypeScript. Node 24 (`export PATH="/Users/davidstrouk/.nvm/versions/node/v24.18.0/bin:$PATH"`).

**Refinement over the design doc:** the design described `deskmate_says` posting directly; a tool's `ctx` can't reach `channel.slack`, so posting lives in the channel's `action.result` handler (which receives the full tool output). Same Approach A, cleaner seam.

---

## Prerequisites

- **PR #2 (`feat/deskmate-slack-identity`) must be merged first** — this feature reuses `agent/lib/deskmate-identity.ts` (`deskmateSlackIdentity`, `chunkMarkdown`), `agent/lib/deskmate-avatars.ts`, and the `message.completed` delivery override in `agent/channels/slack.ts`. Rebase this branch onto merged `main` before starting so those exist.
- Green baseline: `pnpm typecheck && pnpm test && pnpm build` all pass.

Reference files to read first: `agent/channels/slack.ts` (event handlers + identity delivery), `agent/lib/deskmate-identity.ts`, `agent/lib/deskmates.ts` (the `DESKMATES` registry), `agent/instructions.md` (front-desk routing rules), `agent/channels/slack-ambient.ts` (example of `channel.slack`-style Slack calls + state).

> **Test convention (important):** `vitest.config.ts` only discovers `tests/**/*.test.ts`. Put every new test at `tests/<name>.test.ts` and import the subject with a repo-relative path, e.g. `import { x } from "../agent/lib/convene.js";`. The co-located `agent/**/*.test.ts` paths written in the task code blocks below are illustrative — use `tests/` so the runner actually picks them up. (Task 1 already lands at `tests/deskmate-identity.test.ts`.)

---

## Task 1: Roster helper (`deskmateRoster`)

Deskmates are isolated child sessions — they don't know their teammates. The root injects a roster into each convene delegation. Generate it from the `DESKMATES` registry so new deskmates appear automatically.

**Files:**
- Modify: `agent/lib/deskmate-identity.ts`
- Test: `agent/lib/deskmate-identity.test.ts` (create if absent)

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { deskmateRoster } from "./deskmate-identity.js";

describe("deskmateRoster", () => {
  it("lists each deskmate id, name, and one-line role", () => {
    const roster = deskmateRoster();
    expect(roster).toContain("devops");
    expect(roster).toContain("DevOps Engineer");
    expect(roster).toContain("product_analyst");
    expect(roster).toContain("Product Analyst");
  });

  it("can exclude one deskmate (so a deskmate isn't offered itself)", () => {
    const roster = deskmateRoster("devops");
    expect(roster).not.toContain("devops");
    expect(roster).toContain("product_analyst");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run agent/lib/deskmate-identity.test.ts`
Expected: FAIL — `deskmateRoster` is not exported.

**Step 3: Write minimal implementation** (append to `agent/lib/deskmate-identity.ts`)

```ts
import { DESKMATES } from "./deskmates.js";
// (deskmateSlackIdentity/chunkMarkdown already live in this file)

/**
 * One line per teammate, for injecting into a deskmate's convene delegation so
 * it knows who it can tag. Optionally exclude the deskmate itself. Generated
 * from the registry, so new deskmates appear with no further wiring.
 */
export function deskmateRoster(excludeId?: string): string {
  return Object.values(
    DESKMATES as Record<string, { id: string; displayName: string; emoji: string; summary: string }>,
  )
    .filter((d) => d.id !== excludeId)
    .map((d) => `- ${d.id} (${d.emoji} ${d.displayName}): ${d.summary}`)
    .join("\n");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run agent/lib/deskmate-identity.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add agent/lib/deskmate-identity.ts agent/lib/deskmate-identity.test.ts
git commit -m "feat: deskmateRoster helper for convene delegations"
```

---

## Task 2: Convene turn-cap decision (`nextConveneDecision`)

Pure function that owns the hard cap and per-conversation reset. Extracted so the loop logic is unit-tested independently of Slack.

**Files:**
- Create: `agent/lib/convene.ts`
- Test: `agent/lib/convene.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { nextConveneDecision, type ConveneState } from "./convene.js";

describe("nextConveneDecision", () => {
  it("allows the first turn and increments the counter", () => {
    const s: ConveneState = {};
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: true, turnId: "t1", turns: 1 });
  });

  it("keeps counting within the same turn (conversation)", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 2 };
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: true, turnId: "t1", turns: 3 });
  });

  it("resets the counter when a new user turn starts", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 5 };
    expect(nextConveneDecision(s, "t2", 6)).toEqual({ post: true, turnId: "t2", turns: 1 });
  });

  it("refuses to post once the cap is reached", () => {
    const s: ConveneState = { convenedTurnId: "t1", convenedTurns: 6 };
    expect(nextConveneDecision(s, "t1", 6)).toEqual({ post: false, turnId: "t1", turns: 6 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run agent/lib/convene.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation** (`agent/lib/convene.ts`)

```ts
// Turn-cap bookkeeping for a multi-deskmate convene, kept pure so it can be
// unit-tested apart from the Slack channel. A "conversation" is one user turn;
// the counter resets when the turnId changes.

export type ConveneState = {
  convenedTurnId?: string | null;
  convenedTurns?: number;
};

export function nextConveneDecision(
  state: ConveneState,
  turnId: string,
  cap: number,
): { post: boolean; turnId: string; turns: number } {
  const sameTurn = state.convenedTurnId === turnId;
  const prior = sameTurn ? (state.convenedTurns ?? 0) : 0;
  if (prior >= cap) return { post: false, turnId, turns: prior };
  return { post: true, turnId, turns: prior + 1 };
}

export function maxTurns(): number {
  const raw = Number(process.env.DESKMATE_MAX_TURNS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run agent/lib/convene.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add agent/lib/convene.ts agent/lib/convene.test.ts
git commit -m "feat: convene turn-cap decision helper"
```

---

## Task 3: The `deskmate_says` tool

Model-facing action to voice a deskmate's message. It does no posting (a tool can't reach `channel.slack`); it returns the full payload for the channel's `action.result` handler to render, and gives the model a compact ack.

**Files:**
- Create: `agent/tools/deskmate_says.ts`
- Test: `agent/tools/deskmate_says.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import tool from "./deskmate_says.js";

describe("deskmate_says", () => {
  it("returns the deskmate id and text verbatim for the channel to render", async () => {
    const out = await tool.execute({ deskmate: "devops", text: "spikes at 09:00" }, {} as never);
    expect(out).toEqual({ deskmate: "devops", text: "spikes at 09:00" });
  });

  it("summarizes to a short ack for the model", () => {
    const model = tool.toModelOutput?.({ deskmate: "devops", text: "x" });
    expect(model).toEqual({ type: "text", value: "Posted as devops." });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run agent/tools/deskmate_says.test.ts`
Expected: FAIL — module not found.

**Step 3: Write minimal implementation** (`agent/tools/deskmate_says.ts`)

```ts
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

// Voice a message in the current Slack thread AS a specific deskmate. The root
// (front desk) calls this during a convene; the Slack channel's action.result
// handler renders it under that deskmate's name/avatar. Posting a reply is the
// free (non-approval) path, same as any other Slack reply.
export default defineTool({
  description:
    "Post a message into the current Slack thread AS a specific deskmate, so it appears from them " +
    "(their name and avatar). Use this only while convening multiple deskmates. `deskmate` is the " +
    "deskmate id (e.g. 'devops', 'product_analyst'); `text` is their message, in their own voice.",
  inputSchema: z.object({
    deskmate: z.string().min(1),
    text: z.string().min(1),
  }),
  approval: never(),
  async execute({ deskmate, text }) {
    return { deskmate, text };
  },
  toModelOutput(output) {
    return { type: "text", value: `Posted as ${output.deskmate}.` };
  },
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run agent/tools/deskmate_says.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add agent/tools/deskmate_says.ts agent/tools/deskmate_says.test.ts
git commit -m "feat: deskmate_says tool (voice a deskmate in-thread)"
```

---

## Task 4: Render `deskmate_says` in the Slack channel + suppress double-post

Wire the tool into delivery: on `action.result` for `deskmate_says`, enforce the cap and post under the deskmate's identity; on `message.completed`, skip the default post when a convene already voiced the turn.

**Files:**
- Modify: `agent/channels/slack.ts`

**Step 1: Add the `action.result` handler** — inside the `events: { … }` object, alongside the existing `actions.requested` / `message.completed` handlers:

```ts
    // Render a convene turn: the root called deskmate_says; post its text into the
    // thread under that deskmate's identity, bounded by the per-conversation cap.
    async "action.result"(data, channel) {
      const result = data.result as { kind?: string; toolName?: string; output?: unknown };
      if (result?.kind !== "tool-result" || result.toolName !== "deskmate_says") return;
      const output = result.output as { deskmate?: string; text?: string } | undefined;
      const text = output?.text?.trim();
      const channelId = channel.state.channelId;
      const threadTs = channel.state.threadTs;
      if (!text || !channelId || !threadTs) return;

      const decision = nextConveneDecision(channel.state, data.turnId, maxTurns());
      channel.state.convenedTurnId = decision.turnId;
      channel.state.convenedTurns = decision.turns;
      channel.state.convened = true; // suppress the root's default final post this turn
      if (!decision.post) return; // hard cap backstop — drop extra turns

      const identity = deskmateSlackIdentity(output?.deskmate);
      try {
        for (const chunk of chunkMarkdown(text)) {
          const res = await channel.slack.request("chat.postMessage", {
            channel: channelId,
            thread_ts: threadTs,
            markdown_text: chunk,
            ...(identity ? { username: identity.username } : {}),
            ...(identity?.icon_url ? { icon_url: identity.icon_url } : {}),
            ...(identity?.icon_emoji ? { icon_emoji: identity.icon_emoji } : {}),
          });
          if (!res.ok) throw new Error(`chat.postMessage failed: ${res.error}`);
        }
      } catch {
        await channel.thread.post({ markdown: text }); // never drop the content
      }
    },
```

**Step 2: Guard `message.completed` against double-posting** — at the very top of the existing `message.completed` handler, after the `finishReason`/`message` guards:

```ts
      // A convene already voiced this turn via deskmate_says — don't also post the
      // root's final message. Reset for the next turn.
      if (channel.state.convened) {
        channel.state.convened = false;
        return;
      }
```

**Step 3: Add the imports** at the top of `agent/channels/slack.ts`:

```ts
import { maxTurns, nextConveneDecision } from "../lib/convene.js";
```

(Keep the existing `chunkMarkdown, deskmateSlackIdentity` import.)

**Step 4: Extend the channel state type** so `convened*` fields typecheck. If `channel.state` is typed as `SlackChannelState` (no `convened*`), the assignments in Steps 1–2 will fail `tsc`. Mirror PR #2's `activeDeskmateId` cast approach: define local accessors near the top of the file and use them instead of bare property access.

```ts
type ConveneFields = { convened?: boolean; convenedTurnId?: string | null; convenedTurns?: number };
// use (channel.state as ConveneFields).convened, etc., OR reuse the existing
// cast pattern already present for activeDeskmateId. Keep it consistent with PR #2.
```

Apply the same casting style already used in the file for `activeDeskmateId` so the two stay consistent.

**Step 5: Typecheck + build**

Run: `export PATH="/Users/davidstrouk/.nvm/versions/node/v24.18.0/bin:$PATH" && pnpm typecheck && pnpm build`
Expected: both pass.

**Step 6: Commit**

```bash
git add agent/channels/slack.ts
git commit -m "feat: render deskmate_says convene turns + suppress double-post"
```

---

## Task 5: The convene loop instructions

Teach the front desk when and how to convene. Single-domain behavior is unchanged.

**Files:**
- Modify: `agent/instructions.md`

**Step 1: Append a "Convening multiple deskmates" section** (exact markdown):

```markdown
# Convening multiple deskmates
Most requests fit one deskmate — delegate once and relay, as above. Convene several
ONLY when a request genuinely spans domains, or when a deskmate you delegated to asks
for a teammate.

When you convene, do NOT relay in your own voice. Instead, for each turn:
1. Delegate to the deskmate with a `message` that includes: the user's request, the
   relevant findings so far (the deskmate cannot see the thread or other deskmates),
   and this line — "Teammates you can pull in: <roster>. If you need one, set
   `tag` to { deskmate, ask }." Set the subagent's `outputSchema` to
   `{ message: string, tag?: { deskmate: string, ask: string } }`.
2. Call `deskmate_says` with that deskmate's id and their `message`, verbatim, to
   voice them in the thread.
3. If they returned a `tag` for a known, different teammate, make that teammate the
   next turn with `tag.ask` as the focus. Otherwise the conversation is done.

Stop when no one tags anyone, or after ~6 deskmate turns. If you hit the cap, call
`deskmate_says` once with deskmate `"frontdesk"` and a one-line wrap-up. Never voice
a deskmate that isn't in the roster.
```

**Step 2: Regenerate/insert the roster** — the instructions reference `<roster>`; the front desk fills it from context. To make the roster concrete and current, the root's system prompt should include the live roster. Simplest: the model composes it from the deskmate tools' descriptions it already sees, so leaving `<roster>` as a placeholder the model fills is acceptable. (If a static roster is preferred later, inject `deskmateRoster()` via a dynamic instructions resolver — out of scope for v1.)

**Step 3: Build (instructions compile with the agent)**

Run: `export PATH="/Users/davidstrouk/.nvm/versions/node/v24.18.0/bin:$PATH" && pnpm build`
Expected: pass.

**Step 4: Commit**

```bash
git add agent/instructions.md
git commit -m "feat: front-desk convene loop instructions"
```

---

## Task 6: Config + docs

**Files:**
- Modify: `.env.example`, `README.md`

**Step 1:** Add to `.env.example`:

```bash
# Max deskmate turns in one multi-deskmate conversation (safety cap). Default 6.
DESKMATE_MAX_TURNS=6
```

**Step 2:** Add a short "Deskmates collaborating" note to `README.md` describing the visible multi-party behavior, the tag mechanism, and the `DESKMATE_MAX_TURNS` cap.

**Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document multi-deskmate collaboration + DESKMATE_MAX_TURNS"
```

---

## Task 7: Full green + sandbox verification

**Step 1: Full suite**

Run: `export PATH="/Users/davidstrouk/.nvm/versions/node/v24.18.0/bin:$PATH" && pnpm typecheck && pnpm test && pnpm build`
Expected: all pass (existing 24 tests + the new ones).

**Step 2: Deploy + Slack sandbox test** (manual, mirrors prior verification):
- `vercel --prod --yes`.
- In the Dispatch Sandbox `#random`, ask a cross-domain question, e.g. `@Deskmate why did checkout conversion drop, and is it an infra issue?`
- Expect a visible back-and-forth: 📊 Product Analyst and 🔧 DevOps Engineer posting as themselves, one tagging the other, ending naturally.
- Tail logs (`vercel logs <url> --json`) to confirm `deskmate_says` renders and the cap holds. Confirm a single-domain question still posts exactly once (no regression).

**Step 3: Open a PR** for review (separate from PR #2):

```bash
git push -u origin feat/multi-deskmate-interaction
gh pr create --repo mama-sh/deskmate --base main --head feat/multi-deskmate-interaction \
  --title "feat: deskmates collaborate in the open (multi-party threads)"
```

---

## Notes for the implementer

- **DRY:** reuse `deskmateSlackIdentity` / `chunkMarkdown` from PR #2; don't re-implement Slack posting — copy the shape from the `message.completed` handler.
- **YAGNI:** no parallel deskmates, no cross-conversation memory, no per-request/per-channel mode toggle in v1.
- **Idempotency:** `deskmate_says` posting has a side effect (a Slack message). Eve replays completed steps, but a step interrupted mid-execution re-runs — acceptable here (at worst a duplicate reply); do not add retry loops around the post.
- **The face-pile limitation from PR #2 applies** to every convene message too.
