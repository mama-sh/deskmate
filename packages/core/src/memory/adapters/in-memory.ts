import type { Memory, MemoryInput, MemoryScope, MemoryStore } from "../types.js";
import { applyPut } from "../apply.js";
import { scoreMemory } from "../score.js";

const scopeKey = (s: MemoryScope) => `${s.workspace ?? "_"}:${s.deskmate}`;
const MAX = 200;

/** Non-durable adapter for dev/tests/clone. `clock` defaults to Date.now (injected in tests). */
export function createInMemoryStore(clock: () => number = () => Date.now(), maxItems = MAX): MemoryStore {
  const data = new Map<string, Memory[]>();
  return {
    async list(scope, { limit }) {
      const now = clock();
      const items = data.get(scopeKey(scope)) ?? [];
      return [...items].sort((a, b) => scoreMemory(b, now) - scoreMemory(a, now)).slice(0, limit);
    },
    async put(scope, input: MemoryInput) {
      const now = clock();
      const items = data.get(scopeKey(scope)) ?? [];
      const next = applyPut(items, input, { maxItems, now });
      data.set(scopeKey(scope), next);
      return next.find((m) => m.key === input.key)!;
    },
    async delete(scope, key) {
      const items = data.get(scopeKey(scope)) ?? [];
      const filtered = items.filter((m) => m.key !== key);
      data.set(scopeKey(scope), filtered);
      return filtered.length !== items.length;
    },
    async listScopes() {
      const scopes: MemoryScope[] = [];
      for (const [key, items] of data) {
        if (items.length === 0) continue;
        // Keys are `${workspace}:${deskmate}`; deskmate ids and Slack team ids
        // contain no colons, so split on the FIRST ":" to recover the scope.
        const sep = key.indexOf(":");
        scopes.push({ workspace: key.slice(0, sep), deskmate: key.slice(sep + 1) });
      }
      return scopes;
    },
  };
}
