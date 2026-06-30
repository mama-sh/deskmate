import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export type DecisionInput = { title: string; detail: string };
export type DecisionRecord = { recorded: true; id: string; title: string; detail: string };

/** Pure, unit-tested logic. Deterministic id (no Date.now()/random, so tests are stable). */
export function recordDecision(input: DecisionInput): DecisionRecord {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  // Deterministic, dependency-free id for the example. Replace with your store's id.
  const id = "dec_" + Buffer.from(title).toString("hex").slice(0, 12);
  return { recorded: true, id, title, detail: input.detail };
}

export default defineTool({
  description:
    "Record a decision/action proposal (a WRITE). Requires human approval before it runs.",
  inputSchema: z.object({
    title: z.string().min(1).describe("Short imperative title, e.g. 'Roll back deploy abc123'."),
    detail: z.string().describe("Why this is being recorded."),
  }),
  // HUMAN-IN-THE-LOOP: every call pauses for approval in the Slack thread before execute() runs.
  approval: always(),
  async execute({ title, detail }) {
    return recordDecision({ title, detail });
  },
});
