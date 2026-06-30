import { defineTool } from "eve/tools";
import { z } from "zod";

export type Metric = { name: string; value: number; previous: number };
export type MetricWithDelta = Metric & { delta: number; deltaPct: number | null };

/** Pure, unit-tested logic: absolute + percent delta vs the previous period. */
export function withDeltas(metrics: Metric[]): MetricWithDelta[] {
  return metrics.map((m) => ({
    ...m,
    delta: m.value - m.previous,
    deltaPct: m.previous === 0 ? null : ((m.value - m.previous) / m.previous) * 100,
  }));
}

// Seed data so the OSS example runs with zero external infra.
// Replace with a real read (the mixpanel connection, a DB, a warehouse) in production.
const SEED: Metric[] = [
  { name: "signups", value: 120, previous: 100 },
  { name: "activated", value: 64, previous: 70 },
  { name: "dau", value: 980, previous: 940 },
];

export default defineTool({
  description: "Get a snapshot of key product metrics with deltas vs the previous period.",
  inputSchema: z.object({}).describe("No input; returns the current metric snapshot."),
  async execute() {
    return { metrics: withDeltas(SEED) };
  },
});
