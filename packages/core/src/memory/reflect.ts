import type { Memory, MemoryStore, MemoryScope } from "./types.js";
import { applyPut } from "./apply.js";

export type ReflectionOp =
  | { op: "add"; key: string; value: string; importance?: number }        // new semantic fact
  | { op: "merge"; key: string; value: string; importance?: number }      // rewrite an existing memory
  | { op: "supersede"; key: string; value: string; importance?: number }; // demote an outdated semantic fact

/**
 * Guard: an op must never destroy or overwrite a raw episodic record. Any op whose
 * key currently maps to an episodic memory is skipped. Shared by `applyOps` and
 * `reflectScope` so both stay consistent.
 */
function skipEpisodic(op: ReflectionOp, items: Memory[]): boolean {
  const target = items.find((m) => m.key === op.key);
  return !!target && target.kind === "episodic";
}

/** Pure, additive: applies reflection ops. Never deletes or overwrites episodic memories. */
export function applyOps(items: Memory[], ops: ReflectionOp[], opts: { maxItems: number; now: number }): Memory[] {
  let out = items;
  for (const op of ops) {
    if (skipEpisodic(op, out)) continue;
    out = applyPut(out, { key: op.key, value: op.value, kind: "semantic", importance: op.importance }, opts);
  }
  return out;
}

export interface Reflector { (memories: Memory[]): Promise<ReflectionOp[]> }

/** Run reflection for one scope against a store: fetch → reflect → apply ops (additive, episodic-safe). Returns # applied. */
export async function reflectScope(
  store: MemoryStore, scope: MemoryScope, reflect: Reflector, opts: { maxItems: number; now: number },
): Promise<number> {
  const items = await store.list(scope, { limit: opts.maxItems });
  const ops = await reflect(items);
  let applied = 0;
  for (const op of ops) {
    if (skipEpisodic(op, items)) continue;
    await store.put(scope, { key: op.key, value: op.value, kind: "semantic", importance: op.importance });
    applied++;
  }
  return applied;
}
