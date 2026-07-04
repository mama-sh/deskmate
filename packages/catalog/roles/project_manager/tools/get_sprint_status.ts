import { defineTool } from "eve/tools";
import { z } from "zod";

export type IssueStatus = "todo" | "in_progress" | "done";
export type Issue = { key: string; status: IssueStatus; points: number };
export type SprintProgress = {
  totalPoints: number;
  donePoints: number;
  inProgressPoints: number;
  todoPoints: number;
  /** Percent of points completed; null when the sprint has no points. */
  pctComplete: number | null;
  counts: Record<IssueStatus, number>;
};

/** Pure, unit-tested logic: roll issues up into sprint progress by story points. */
export function sprintProgress(issues: Issue[]): SprintProgress {
  const counts: Record<IssueStatus, number> = { todo: 0, in_progress: 0, done: 0 };
  let donePoints = 0;
  let inProgressPoints = 0;
  let todoPoints = 0;
  for (const issue of issues) {
    counts[issue.status]++;
    if (issue.status === "done") donePoints += issue.points;
    else if (issue.status === "in_progress") inProgressPoints += issue.points;
    else todoPoints += issue.points;
  }
  const totalPoints = donePoints + inProgressPoints + todoPoints;
  const pctComplete = totalPoints === 0 ? null : (donePoints / totalPoints) * 100;
  return { totalPoints, donePoints, inProgressPoints, todoPoints, pctComplete, counts };
}

// Seed data so the OSS example runs with zero external infra.
// Replace with a real read (the linear connection, your issue tracker).
const SEED: Issue[] = [
  { key: "ENG-1", status: "done", points: 5 },
  { key: "ENG-2", status: "in_progress", points: 3 },
  { key: "ENG-3", status: "todo", points: 8 },
  { key: "ENG-4", status: "done", points: 2 },
];

export default defineTool({
  description: "Get sprint status rolled up by story points (done / in progress / todo, percent complete).",
  inputSchema: z.object({}).describe("No input; returns the current sprint status."),
  async execute() {
    return { sprint: sprintProgress(SEED) };
  },
});
