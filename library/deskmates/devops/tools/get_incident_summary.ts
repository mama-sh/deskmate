import { defineTool } from "eve/tools";
import { z } from "zod";

export type Incident = { signature: string; at: string };
export type IncidentGroup = { signature: string; count: number; firstSeen: string; lastSeen: string };

/** Pure, unit-tested logic: group incidents by signature, sorted by count desc. */
export function summarizeIncidents(rows: Incident[]): IncidentGroup[] {
  const groups = new Map<string, IncidentGroup>();
  for (const r of rows) {
    const g = groups.get(r.signature);
    if (!g) {
      groups.set(r.signature, { signature: r.signature, count: 1, firstSeen: r.at, lastSeen: r.at });
    } else {
      g.count++;
      if (r.at < g.firstSeen) g.firstSeen = r.at;
      if (r.at > g.lastSeen) g.lastSeen = r.at;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Seed data so the OSS example runs with zero external infra.
// Replace with a real read (the sentry connection, a log store, an error tracker).
const SEED: Incident[] = [
  { signature: "TimeoutError calling /api/pay", at: "2026-06-30T10:00:00Z" },
  { signature: "TimeoutError calling /api/pay", at: "2026-06-30T10:05:00Z" },
  { signature: "NullDeref in renderCard", at: "2026-06-30T09:00:00Z" },
];

export default defineTool({
  description: "Summarize recent incidents grouped by error signature (count, first/last seen).",
  inputSchema: z.object({}).describe("No input; returns the current incident summary."),
  async execute() {
    return { incidents: summarizeIncidents(SEED) };
  },
});
