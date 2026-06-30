import { describe, it, expect } from "vitest";
import {
  summarizeIncidents,
  type Incident,
} from "../library/deskmates/devops/tools/get_incident_summary.js";

describe("summarizeIncidents", () => {
  it("groups by signature and counts, sorted by count desc", () => {
    const rows: Incident[] = [
      { signature: "TimeoutError", at: "2026-06-30T10:00:00Z" },
      { signature: "TimeoutError", at: "2026-06-30T10:05:00Z" },
      { signature: "NullDeref", at: "2026-06-30T09:00:00Z" },
    ];
    expect(summarizeIncidents(rows)).toEqual([
      { signature: "TimeoutError", count: 2, firstSeen: "2026-06-30T10:00:00Z", lastSeen: "2026-06-30T10:05:00Z" },
      { signature: "NullDeref", count: 1, firstSeen: "2026-06-30T09:00:00Z", lastSeen: "2026-06-30T09:00:00Z" },
    ]);
  });

  it("returns [] for no rows", () => {
    expect(summarizeIncidents([])).toEqual([]);
  });
});
