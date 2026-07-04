import type { Memory } from "./types.js";

const DAY_MS = 86_400_000;
const RECENCY_WEIGHT = 5; // recency ∈ [0,1] contributes up to 5, comparable to importance 1–10

/** recency = 1 / (1 + ageDays); combined with importance. Deterministic given `now`. */
export function scoreMemory(m: Memory, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(m.updatedAt)) / DAY_MS);
  const recency = 1 / (1 + ageDays);
  return m.importance + RECENCY_WEIGHT * recency;
}

/** Pin the top-N memories (core memory), highest score first. */
export function pinCore(items: Memory[], limit: number, now: number): Memory[] {
  return [...items].sort((a, b) => scoreMemory(b, now) - scoreMemory(a, now)).slice(0, limit);
}
