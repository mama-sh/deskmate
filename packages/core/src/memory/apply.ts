import type { Memory, MemoryInput } from "./types.js";
import { scoreMemory } from "./score.js";

const clampImportance = (n: number | undefined): number =>
  Math.max(1, Math.min(10, Math.round(n ?? 5)));

/** Pure: dedupe-by-key put + evict-lowest-score when over cap. Deterministic given `now`. */
export function applyPut(
  items: Memory[],
  input: MemoryInput,
  opts: { maxItems: number; now: number },
): Memory[] {
  const iso = new Date(opts.now).toISOString();
  const existing = items.find((m) => m.key === input.key);
  const next: Memory = {
    key: input.key,
    value: input.value,
    kind: input.kind ?? existing?.kind ?? "semantic",
    importance: clampImportance(input.importance ?? existing?.importance),
    createdAt: existing?.createdAt ?? iso,
    updatedAt: iso,
  };
  const others = items.filter((m) => m.key !== input.key);
  const merged = [...others, next];
  if (merged.length <= opts.maxItems) return merged;
  // Forgetting: ALWAYS keep the just-written memory; evict the lowest-scored of the rest.
  // (Sorting all of `merged` could drop `next`, breaking adapters' `find(input.key)!`.)
  const keptOthers = [...others]
    .sort((a, b) => scoreMemory(b, opts.now) - scoreMemory(a, opts.now))
    .slice(0, opts.maxItems - 1);
  return [...keptOthers, next];
}
