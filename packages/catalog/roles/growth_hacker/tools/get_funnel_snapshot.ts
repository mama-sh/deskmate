import { defineTool } from "eve/tools";
import { z } from "zod";

export type FunnelStep = { name: string; count: number };
export type FunnelStepResult = FunnelStep & {
  /** Percent conversion vs the previous step; null for the first step or when the previous count is 0. */
  conversionFromPrev: number | null;
  /** Percent conversion vs the top of the funnel; 0 when the top step is 0. */
  conversionFromTop: number;
};

/** Pure, unit-tested logic: step-over-step and step-over-top conversion, as percentages. */
export function funnelConversion(steps: FunnelStep[]): FunnelStepResult[] {
  const top = steps[0]?.count ?? 0;
  return steps.map((step, i) => {
    const prev = i === 0 ? null : steps[i - 1].count;
    const conversionFromPrev =
      prev === null ? null : prev === 0 ? null : (step.count / prev) * 100;
    const conversionFromTop = top === 0 ? 0 : (step.count / top) * 100;
    return { ...step, conversionFromPrev, conversionFromTop };
  });
}

// Seed data so the OSS example runs with zero external infra.
// Replace with a real read (the posthog connection, your analytics warehouse).
const SEED: FunnelStep[] = [
  { name: "visited", count: 1000 },
  { name: "signed_up", count: 200 },
  { name: "activated", count: 50 },
];

export default defineTool({
  description: "Get an acquisition/activation funnel snapshot with step-over-step conversion.",
  inputSchema: z.object({}).describe("No input; returns the current funnel snapshot."),
  async execute() {
    return { funnel: funnelConversion(SEED) };
  },
});
