# Deskmate voice + iteration-loop upgrade — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Make `@deskmate` Slack replies read like a real coworker (not AI) and tighten the interaction loop, via a shared house-style/voice block, a per-deskmate `voice` field, and loop-discipline instructions — no extra model calls, no added latency.

**Architecture:** Deskmate is an `eve` app. A front-desk router (`packages/core/src/front-desk-instructions.md`) delegates to per-role subagents ("deskmates"). `deskmate sync` codegen (`packages/cli/src/sync/`) regenerates `agent/**`: the front desk's prose comes from core's markdown; each deskmate's instructions are the role's `instructions.md` copied verbatim. We add a shared "house style" markdown asset in **core**, and have `sync` compose it (plus an optional per-deskmate `voice` line) under each deskmate's role instructions. Front-desk gets targeted edits directly. Everything is prompt/instruction-level.

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, Vitest, pnpm workspace (`@deskmate/core`, `@deskmate/cli`, `@deskmate/catalog`).

**Design doc:** `docs/plans/2026-07-04-deskmate-iteration-loop-design.md`

**Conventions:**
- Build core after editing it, before running CLI tests: CLI `render.ts` `require`s core's built markdown exports from `dist`. Command: `pnpm --filter @deskmate/core build`.
- Test commands: `pnpm --filter @deskmate/core test`, `pnpm --filter @deskmate/cli test`, `pnpm --filter @deskmate/catalog test`. Typecheck: `pnpm -r typecheck`.
- Match surrounding code style: dense explanatory comments on the *why*, JSON-encoded values in generated files, deterministic output.

---

### Task 1: Add optional `voice` field to `DeskmateConfig`

**Files:**
- Modify: `packages/core/src/config.ts:8-16` (the `DeskmateConfig` schema)
- Test: `packages/core/test/config.test.ts`

**Step 1: Write the failing test**

Add to `packages/core/test/config.test.ts`:

```ts
it("accepts an optional per-deskmate voice line", () => {
  const team = defineTeam({
    deskmates: {
      devops: {
        role: "devops",
        emoji: ":wrench:",
        displayName: "DevOps Engineer",
        summary: "Triages incidents.",
        voice: "Terse SRE. Leads with the punchline.",
      },
    },
  });
  expect(team.deskmates.devops.voice).toBe("Terse SRE. Leads with the punchline.");
});

it("leaves voice undefined when omitted", () => {
  const team = defineTeam({
    deskmates: {
      devops: { role: "devops", emoji: ":wrench:", displayName: "DevOps", summary: "x" },
    },
  });
  expect(team.deskmates.devops.voice).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/core test -- config`
Expected: FAIL — `voice` is stripped by Zod (unknown key) so the first test's assertion is `undefined === "Terse SRE…"`.

**Step 3: Implement**

In `packages/core/src/config.ts`, add `voice` to `DeskmateConfig` (after `model`):

```ts
const DeskmateConfig = z.object({
  role: z.string(),
  emoji: z.string(),
  displayName: z.string(),
  summary: z.string(),
  reads: z.array(z.string()).default([]),
  model: z.string().optional(),
  skill: z.string().optional(),
  voice: z.string().optional(), // one line of persona/register, injected under the shared house style
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @deskmate/core test -- config`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): add optional per-deskmate voice field"
```

---

### Task 2: Create the shared house-style asset + export

**Files:**
- Create: `packages/core/src/house-style.md`
- Create: `packages/core/src/house-style.ts`
- Modify: `packages/core/package.json` (add `./house-style` export + build copy)
- Test: `packages/core/test/house-style.test.ts`

**Step 1: Write the failing test**

Create `packages/core/test/house-style.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { houseStyle } from "../src/house-style.js";

describe("houseStyle", () => {
  it("is non-empty prose with the voice and work sections", () => {
    expect(houseStyle).toContain("## How you write");
    expect(houseStyle).toContain("## How you work");
  });

  it("names the highest-signal anti-AI rules", () => {
    expect(houseStyle).toContain("Lead with the answer");
    expect(houseStyle).toContain("clarifying question"); // ask-don't-guess
    expect(houseStyle.toLowerCase()).toContain("reread"); // in-prompt humanize pass
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @deskmate/core test -- house-style`
Expected: FAIL — `../src/house-style.js` does not exist.

**Step 3: Create the markdown asset**

Create `packages/core/src/house-style.md` with EXACTLY this content:

```markdown
## How you write
You're a coworker dropping a message in Slack, not an AI assistant writing a report. Write like a sharp colleague who's busy but helpful.

- Lead with the answer. The first line is the punchline. No "Here's what I found", no "Great question", no restating their question back to them.
- Keep it short. A Slack message, not an essay. Most answers are one to four sentences. Add detail only if it changes what they'd do next.
- Prose over bullets. Only use a list for genuinely list-shaped data (three or more parallel items). Never write `**Label:** text` inline-header lists — that pattern is the number-one tell of AI writing.
- Plain punctuation. Commas and periods, not em dashes. Straight quotes. Bold at most one thing, and only when it's a number or name that matters.
- Talk like a person. Write in the first person. Have a view ("I'd hold off on that"). Say when you're unsure ("not certain yet, still digging"). Vary your sentence length.
- Cut the AI tells. Don't use: delve, leverage (as a verb), robust, seamless, crucial, pivotal, underscore, foster, "it's not just X, it's Y", "from X to Y", or a generic upbeat closer. Skip "let me know if you need anything else" — either offer a specific next step or just stop.
- Before you send, reread your draft and delete anything that sounds like a machine wrote it.

## How you work
- Ground every claim in a tool result. Show the source briefly (the query you ran, the dashboard, the file). Never state a number you didn't actually pull.
- If the request is ambiguous or missing a detail you can't infer, ask ONE sharp clarifying question instead of guessing. A wrong assumption costs more than a five-second question.
- If you're speculating, say so plainly rather than dressing it up as fact.
```

**Step 4: Create the loader**

Create `packages/core/src/house-style.ts` (mirrors `front-desk-instructions.ts`):

```ts
import { readFileSync } from "node:fs";

// The shared "house style" block: how every deskmate should write (voice) and work
// (grounding, clarifying questions). `deskmate sync` composes this UNDER each
// deskmate's role instructions when generating `agent/subagents/<id>/instructions.md`,
// so the voice is authored once here instead of copy-pasted into every role. Kept as
// a sibling `.md` (read at import time), like the front-desk template, so the prose —
// dense with backticks and em-dash examples — stays byte-for-byte faithful with zero
// escaping. Exposed on its own subpath export so importing it doesn't pull core's
// runtime graph.
export const houseStyle: string = readFileSync(
  new URL("./house-style.md", import.meta.url),
  "utf8",
);
```

**Step 5: Wire up the package export + build copy**

In `packages/core/package.json`, add to `exports` (after the `./front-desk-instructions` block):

```json
    "./house-style": {
      "types": "./dist/house-style.d.ts",
      "default": "./dist/house-style.js"
    }
```

And update the `build` script to copy both markdown assets:

```json
    "build": "tsc -p tsconfig.build.json && node -e \"const fs=require('node:fs'); for (const f of ['front-desk-instructions.md','house-style.md']) fs.copyFileSync('src/'+f,'dist/'+f)\"",
```

**Step 6: Build core, then run the test**

Run: `pnpm --filter @deskmate/core build && pnpm --filter @deskmate/core test -- house-style`
Expected: PASS. Verify `packages/core/dist/house-style.md` exists.

**Step 7: Commit**

```bash
git add packages/core/src/house-style.md packages/core/src/house-style.ts \
  packages/core/package.json packages/core/test/house-style.test.ts
git commit -m "feat(core): add shared house-style voice + work block"
```

---

### Task 3: Compose house-style + voice into subagent instructions

**Files:**
- Modify: `packages/cli/src/sync/render.ts` (add `renderSubagentInstructions`)
- Modify: `packages/cli/src/sync/plan.ts:111-118` (use it, both branches)
- Test: `packages/cli/test/render.test.ts`, `packages/cli/test/plan.test.ts`

**Step 1: Write the failing test (render)**

Add to `packages/cli/test/render.test.ts` (and add `renderSubagentInstructions` to the imports from `../src/sync/render.js`):

```ts
describe("renderSubagentInstructions", () => {
  const role = "# Role: DevOps\nAuthored, verbatim.\n";

  it("keeps the authored role instructions, then appends the house style", () => {
    const out = renderSubagentInstructions(role);
    expect(out.startsWith("# Role: DevOps")).toBe(true);
    expect(out).toContain("Authored, verbatim.");
    expect(out).toContain("## How you write");
    expect(out).toContain("## How you work");
  });

  it("adds a voice section only when a voice line is given", () => {
    expect(renderSubagentInstructions(role)).not.toContain("## Your voice");
    const out = renderSubagentInstructions(role, "Terse SRE. Dry, not chatty.");
    expect(out).toContain("## Your voice");
    expect(out).toContain("Terse SRE. Dry, not chatty.");
  });

  it("ends with exactly one trailing newline (deterministic)", () => {
    expect(renderSubagentInstructions(role)).toMatch(/[^\n]\n$/);
  });
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @deskmate/cli test -- render`
Expected: FAIL — `renderSubagentInstructions` is not exported.

**Step 3: Implement the renderer**

In `packages/cli/src/sync/render.ts`, add (near `renderFrontDeskInstructions`, reusing the lazy `require`):

```ts
/**
 * `agent/subagents/<id>/instructions.md` — the authored role instructions composed
 * with core's shared house-style block (voice + work discipline) and, when set, the
 * deskmate's one-line `voice`. Authoring the house style once in core (instead of
 * copy-pasting it into every role file) is why this composes at sync time rather than
 * copying the role file verbatim. Role prose comes first (who you are / how this role
 * works), then the shared style, then the per-deskmate voice. Exactly one trailing
 * newline keeps the write deterministic → idempotent.
 */
export function renderSubagentInstructions(roleInstructions: string, voice?: string): string {
  const { houseStyle } = require("@deskmate/core/house-style") as { houseStyle: string };
  const voiceBlock = voice ? `\n\n## Your voice\n${voice}` : "";
  return `${roleInstructions.trimEnd()}\n\n${houseStyle.trimEnd()}${voiceBlock}\n`;
}
```

**Step 4: Use it in the sync plan**

In `packages/cli/src/sync/plan.ts`, import `renderSubagentInstructions` (add to the `./render.js` import block), then change the instructions branch (lines 111-118):

```ts
    // instructions.md — authored role instructions composed with core's shared
    // house-style block (voice + work discipline) + the deskmate's optional `voice`.
    const instrPath = join(cwd, "roles", role, "instructions.md");
    const roleInstructions = existsSync(instrPath)
      ? readFileSync(instrPath, "utf8")
      : missingInstructions(id, role);
    if (!existsSync(instrPath)) {
      warnings.push(`deskmate "${id}": no authored roles/${role}/instructions.md — wrote a TODO placeholder.`);
    }
    out(`agent/subagents/${id}/instructions.md`, renderSubagentInstructions(roleInstructions, d.voice));
```

**Step 5: Update the existing plan tests**

In `packages/cli/test/plan.test.ts`:

- The test at line 135 ("copies subagent instructions.md byte-for-byte from the authored role") no longer holds. Replace its body so it asserts composition instead of equality:

```ts
it("composes subagent instructions from the authored role + the house style", () => {
  const plan = planSync(team, cwd);
  const authored = readFileSync(join(cwd, "roles/devops/instructions.md"), "utf8");
  const write = find(plan, "agent/subagents/devops/instructions.md");
  const text = write.contents.toString();
  expect(text.startsWith(authored.trimEnd())).toBe(true); // role prose preserved, first
  expect(text).toContain("## How you write"); // shared house style appended
});
```

- The assertion around line 221-222 (mapped-role `ops` gets instructions "verbatim from roles/devops, NOT the TODO placeholder") should assert the authored text is still present *and* the house style was appended:

```ts
    const instr = find(plan, "agent/subagents/ops/instructions.md");
    expect(instr.contents.toString()).toContain("Authored, verbatim.");
    expect(instr.contents.toString()).toContain("## How you write");
```

- If a `voice` is set on a deskmate in that test's fixture, add an assertion that `## Your voice` appears. (Optional — only if you extend the fixture.)

**Step 6: Build core (for the require) + run tests**

Run: `pnpm --filter @deskmate/core build && pnpm --filter @deskmate/cli test -- "render|plan"`
Expected: PASS (render + plan suites).

Then run the full CLI suite to catch the idempotency/sync snapshot tests:

Run: `pnpm --filter @deskmate/cli test`
Expected: PASS. If `sync.test.ts` compares generated instructions to a fixture, update that fixture to the composed output.

**Step 7: Commit**

```bash
git add packages/cli/src/sync/render.ts packages/cli/src/sync/plan.ts \
  packages/cli/test/render.test.ts packages/cli/test/plan.test.ts
git commit -m "feat(sync): compose house-style + voice into deskmate instructions"
```

---

### Task 4: Front-desk continuity + voice note

**Files:**
- Modify: `packages/core/src/front-desk-instructions.md`
- Test: `packages/cli/test/render.test.ts` (`renderFrontDeskInstructions` describe block, ~line 162)

**Step 1: Write the failing test**

In `packages/cli/test/render.test.ts`, inside the `renderFrontDeskInstructions` describe block, add:

```ts
it("tells the front desk to keep follow-ups with the same deskmate", () => {
  const out = renderFrontDeskInstructions();
  expect(out.toLowerCase()).toContain("follow-up");
  expect(out).toContain("same deskmate");
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @deskmate/core build && pnpm --filter @deskmate/cli test -- render`
Expected: FAIL — the phrase isn't in the front-desk prose yet.

**Step 3: Edit the front-desk instructions**

In `packages/core/src/front-desk-instructions.md`, add a new routing rule (after rule 5) in the `# Routing rules` section:

```markdown
6. Keep a conversation with one deskmate. If this thread was already handled by a
   deskmate and the new message is a follow-up in their domain, delegate to the SAME
   deskmate again, and include the earlier question and their answer in `message` so
   they can pick up where they left off. Only switch deskmates if the topic clearly
   moved to another role's domain.
```

And add a short voice note at the end of the `# Identity` section (so the front desk's *own* messages — "no deskmate fits", convene wrap-ups — don't read as AI):

```markdown
When you do write in your own voice (e.g. no deskmate fits, or a convene wrap-up), write
like a person, not an AI report: lead with the point, keep it short, no bullet-point
padding, no em dashes, no "let me know if you need anything else".
```

**Step 4: Build core + run tests**

Run: `pnpm --filter @deskmate/core build && pnpm --filter @deskmate/cli test -- render`
Expected: PASS. The existing assertion for `# Convening multiple deskmates` still passes.

**Step 5: Commit**

```bash
git add packages/core/src/front-desk-instructions.md packages/cli/test/render.test.ts
git commit -m "feat(core): front-desk follow-up continuity + human voice note"
```

---

### Task 5: Seed `voice` through `deskmate add` + catalog manifests

**Files:**
- Modify: `packages/cli/src/add.ts:9-32` (`RoleIdentity` + `entryFromRole`)
- Modify: `packages/catalog/roles/*/deskmate.json` (5 roles: devops, project_manager, growth_hacker, product_analyst, customer_success)
- Test: `packages/cli/test/add.test.ts`

**Step 1: Write the failing test**

Add to `packages/cli/test/add.test.ts` (unit test for `entryFromRole`; match the existing import/test style there):

```ts
it("carries an optional voice from the role manifest into the config entry", () => {
  const entry = entryFromRole({
    id: "devops",
    displayName: "DevOps Engineer",
    emoji: ":wrench:",
    summary: "Triages incidents.",
    voice: "Terse SRE. Dry, not chatty.",
    providers: ["sentry"],
  });
  expect(entry.voice).toBe("Terse SRE. Dry, not chatty.");
});

it("omits voice when the manifest has none", () => {
  const entry = entryFromRole({
    id: "devops",
    displayName: "DevOps Engineer",
    emoji: ":wrench:",
    summary: "Triages incidents.",
  });
  expect("voice" in entry).toBe(false);
});
```

**Step 2: Run to verify it fails**

Run: `pnpm --filter @deskmate/cli test -- add`
Expected: FAIL — `entryFromRole` drops `voice`.

**Step 3: Implement**

In `packages/cli/src/add.ts`, add `voice?` to `RoleIdentity` and spread it in `entryFromRole`:

```ts
type RoleIdentity = {
  id: string;
  displayName: string;
  emoji: string;
  summary: string;
  skill?: string;
  voice?: string;
  providers?: string[];
};

export function entryFromRole(role: RoleIdentity): Record<string, unknown> {
  return {
    role: role.id,
    emoji: role.emoji,
    displayName: role.displayName,
    summary: role.summary,
    ...(role.skill ? { skill: role.skill } : {}),
    ...(role.voice ? { voice: role.voice } : {}),
    reads: role.providers ?? [],
  };
}
```

(`renderEntry` in `config-file.ts` serializes any field via `JSON.stringify`, so no change is needed there — the new `voice` key is written automatically.)

**Step 4: Add a `voice` line to each catalog role manifest**

Add a `voice` field to each `packages/catalog/roles/<role>/deskmate.json`. Suggested lines (adjust to taste, one sentence each):

- `devops`: `"Terse SRE. Leads with the punchline, shows the query he ran, flags risk plainly. Dry, not chatty."`
- `product_analyst`: `"Calm analyst. States what moved and the number behind it, then what to look at next. No hype."`
- `project_manager`: `"Organized PM. Direct about status and blockers, names owners and dates, skips the fluff."`
- `growth_hacker`: `"Scrappy growth lead. Concrete and experiment-minded; frames things as what to try and what it'd tell us."`
- `customer_success`: `"Warm CS lead. Plain-spoken about account health and risk, practical about the next move."`

Example (`packages/catalog/roles/devops/deskmate.json`):

```json
{
  "id": "devops",
  "displayName": "DevOps Engineer",
  "emoji": ":wrench:",
  "summary": "Triages errors and incidents from logs/monitoring, explains likely causes, and proposes (never auto-applies) fixes.",
  "skill": "erichowens/some_claude_skills@logging-observability",
  "voice": "Terse SRE. Leads with the punchline, shows the query he ran, flags risk plainly. Dry, not chatty.",
  "providers": ["sentry"]
}
```

**Step 5: Run tests**

Run: `pnpm --filter @deskmate/cli test -- add`
Expected: PASS.

Run: `pnpm --filter @deskmate/catalog test`
Expected: PASS. If the catalog package has a manifest-shape/schema test, confirm it allows the new `voice` key (add it to the schema if one exists).

**Step 6: Commit**

```bash
git add packages/cli/src/add.ts packages/cli/test/add.test.ts packages/catalog/roles/*/deskmate.json
git commit -m "feat(cli,catalog): seed deskmate voice from the role manifest"
```

---

### Task 6: Example voice in the starter + anti-slop guard

**Files:**
- Modify: `examples/starter/deskmate.config.ts` (add `voice` to both deskmates)
- Regenerate: `examples/starter/agent/**` via `deskmate sync`
- Test: `packages/core/test/house-style.test.ts` (add the anti-slop assertions)

**Step 1: Add an anti-slop regression guard**

The house-style block is our anti-AI checklist; the guard asserts the block itself keeps banning the highest-signal tells (so a future edit can't silently gut it). Add to `packages/core/test/house-style.test.ts`:

```ts
it("keeps banning the highest-signal AI tells", () => {
  for (const tell of ["inline-header", "em dash", "delve"]) {
    expect(houseStyle.toLowerCase()).toContain(tell.toLowerCase());
  }
});
```

Adjust the substrings to match the exact wording you used in `house-style.md` (e.g. the block says "inline-header lists", "em dashes", "delve").

**Step 2: Run to verify it passes (or fails meaningfully)**

Run: `pnpm --filter @deskmate/core test -- house-style`
Expected: PASS if the wording matches; FAIL points you at a wording mismatch to fix in the test.

**Step 3: Add example voice lines to the starter config**

In `examples/starter/deskmate.config.ts`, add a `voice` line to each deskmate:

```ts
    product_analyst: {
      role: "product_analyst",
      emoji: ":bar_chart:",
      displayName: "Product Analyst",
      summary:
        "Turns product usage data into a short narrative: what changed, why, what to look at next.",
      skill: "ncklrs/startup-os-skills@product-analyst",
      voice: "Calm analyst. States what moved and the number behind it, then what to look at next. No hype.",
      reads: ["mixpanel"],
    },
    devops: {
      role: "devops",
      emoji: ":wrench:",
      displayName: "DevOps Engineer",
      summary:
        "Triages errors and incidents from logs/monitoring, explains likely causes, and proposes (never auto-applies) fixes.",
      skill: "erichowens/some_claude_skills@logging-observability",
      voice: "Terse SRE. Leads with the punchline, shows the query he ran, flags risk plainly. Dry, not chatty.",
      reads: ["sentry"],
    },
```

**Step 4: Regenerate the starter's agent tree**

Run: `pnpm --filter @deskmate/core build` (ensure dist is current), then from `examples/starter/`:
`node ../../packages/cli/bin/... sync` — use the repo's documented way to run the CLI (check `examples/starter/package.json` `build`/`sync` script; it likely runs `deskmate sync`). If a `sync` script exists: `pnpm --filter deskmate-starter... run sync` or `cd examples/starter && pnpm build`.

Verify: `examples/starter/agent/subagents/devops/instructions.md` now contains the authored role text, then `## How you write`, `## How you work`, and `## Your voice` with the devops line.

**Step 5: Run the starter smoke test + full suite**

Run: `pnpm -r test`
Expected: PASS. If the starter has a smoke test asserting on generated instructions, update its expectation to the composed output.

Run: `pnpm -r typecheck`
Expected: PASS.

**Step 6: Commit**

```bash
git add examples/starter/deskmate.config.ts examples/starter/agent packages/core/test/house-style.test.ts
git commit -m "feat(starter): example deskmate voices + anti-slop guard; regen agent tree"
```

---

### Task 7: Verify end-to-end + docs

**Files:**
- Modify: `README.md` (document the `voice` field + house style, if the README lists config fields)
- Verify: full build + test

**Step 1: Full verification**

Run: `pnpm -r test && pnpm -r typecheck && pnpm run build:packages`
Expected: all PASS/clean.

**Step 2: Eyeball a generated deskmate**

Read `examples/starter/agent/subagents/devops/instructions.md` end-to-end. Confirm it reads as a coherent instruction file: role → how you write → how you work → your voice, with one trailing newline and no doubled headers.

**Step 3: Document the field**

If `README.md` documents `deskmate.config.ts` fields, add `voice` (optional, one-line persona) and mention the shared house style is applied to every deskmate automatically. Keep it short.

**Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document the per-deskmate voice field + house style"
```

---

## Manual QA (not automatable here)

After deploy, in Slack: tag `@deskmate` with (a) a clear ask, (b) an ambiguous ask (expect ONE clarifying question, not a guess), and (c) a follow-up in the thread (expect the same deskmate, with continuity). Eyeball the replies against the house-style checklist: no `**Label:**` lists, no em dashes, leads with the answer, sounds like a person. Iterate on `house-style.md` / per-deskmate `voice` from what you see.

## Rollback

Every task is an isolated commit. Revert any task without touching the others; the `voice` field is optional and the house-style composition degrades to "role instructions + shared block" when no voice is set.
