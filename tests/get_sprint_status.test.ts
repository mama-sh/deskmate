import { describe, it, expect } from "vitest";
import { sprintProgress } from "../library/deskmates/project_manager/tools/get_sprint_status.js";

describe("sprintProgress", () => {
  it("rolls issues up by story points", () => {
    const result = sprintProgress([
      { key: "ENG-1", status: "done", points: 5 },
      { key: "ENG-2", status: "in_progress", points: 3 },
      { key: "ENG-3", status: "todo", points: 8 },
      { key: "ENG-4", status: "done", points: 2 },
    ]);
    expect(result.totalPoints).toBe(18);
    expect(result.donePoints).toBe(7);
    expect(result.inProgressPoints).toBe(3);
    expect(result.todoPoints).toBe(8);
    expect(result.pctComplete).toBeCloseTo(38.888, 2);
    expect(result.counts).toEqual({ todo: 1, in_progress: 1, done: 2 });
  });

  it("returns null pctComplete for an empty sprint", () => {
    const result = sprintProgress([]);
    expect(result.totalPoints).toBe(0);
    expect(result.pctComplete).toBeNull();
    expect(result.counts).toEqual({ todo: 0, in_progress: 0, done: 0 });
  });
});
