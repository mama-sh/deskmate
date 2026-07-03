import { defineTool } from "eve/tools";
import { z } from "zod";

export type Account = { name: string; activeUsers: number; seats: number; openTickets: number };
export type HealthBand = "healthy" | "at_risk" | "critical";
export type AccountHealth = Account & { utilization: number; health: HealthBand };

const RANK: Record<HealthBand, number> = { critical: 0, at_risk: 1, healthy: 2 };

/**
 * Pure, unit-tested logic. Scores each account by seat utilization and support load,
 * then sorts most-at-risk first. `utilization` is activeUsers / seats (0 when no seats).
 */
export function scoreAccounts(accounts: Account[]): AccountHealth[] {
  const scored = accounts.map((a): AccountHealth => {
    const utilization = a.seats === 0 ? 0 : a.activeUsers / a.seats;
    let health: HealthBand = "healthy";
    if (utilization < 0.3 || a.openTickets > 5) health = "critical";
    else if (utilization < 0.6 || a.openTickets > 2) health = "at_risk";
    return { ...a, utilization, health };
  });
  return scored.sort(
    (a, b) => RANK[a.health] - RANK[b.health] || a.utilization - b.utilization,
  );
}

// Seed data so the OSS example runs with zero external infra.
// Replace with a real read (the intercom connection, your CRM, a usage warehouse).
const SEED: Account[] = [
  { name: "Acme", activeUsers: 3, seats: 25, openTickets: 1 },
  { name: "Globex", activeUsers: 18, seats: 20, openTickets: 0 },
  { name: "Initech", activeUsers: 9, seats: 20, openTickets: 6 },
];

export default defineTool({
  description: "Score accounts by health (seat utilization + open support tickets), most at risk first.",
  inputSchema: z.object({}).describe("No input; returns the current account-health snapshot."),
  async execute() {
    return { accounts: scoreAccounts(SEED) };
  },
});
