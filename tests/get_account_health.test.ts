import { describe, it, expect } from "vitest";
import { scoreAccounts } from "../library/deskmates/customer_success/tools/get_account_health.js";

describe("scoreAccounts", () => {
  it("bands accounts and sorts most-at-risk first", () => {
    const result = scoreAccounts([
      { name: "Globex", activeUsers: 18, seats: 20, openTickets: 0 }, // util 0.9 -> healthy
      { name: "Acme", activeUsers: 3, seats: 25, openTickets: 1 }, // util 0.12 -> critical
      { name: "Initech", activeUsers: 9, seats: 20, openTickets: 6 }, // tickets > 5 -> critical
    ]);
    expect(result.map((a) => [a.name, a.health])).toEqual([
      ["Acme", "critical"], // lowest utilization first among criticals
      ["Initech", "critical"],
      ["Globex", "healthy"],
    ]);
  });

  it("flags the mid band as at_risk", () => {
    const [row] = scoreAccounts([{ name: "Mid", activeUsers: 10, seats: 20, openTickets: 0 }]);
    expect(row.utilization).toBe(0.5);
    expect(row.health).toBe("at_risk");
  });

  it("treats zero seats as zero utilization (critical), no divide-by-zero", () => {
    const [row] = scoreAccounts([{ name: "Empty", activeUsers: 0, seats: 0, openTickets: 0 }]);
    expect(row.utilization).toBe(0);
    expect(row.health).toBe("critical");
  });
});
