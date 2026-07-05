import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { resolveMemoryStore } from "./store.js";
import { resolveScope } from "./scope.js";
import type { Memory } from "./types.js";

const POOL_CAP = 200; // matches the adapters' store cap; search the whole pool before limiting

/** Pure: filter a memory pool by an optional substring query, then cap to `limit`. */
export function searchMemories(pool: Memory[], query: string | undefined, limit: number): Memory[] {
  if (!query) return pool.slice(0, limit);
  const q = query.toLowerCase();
  return pool
    .filter((m) => m.value.toLowerCase().includes(q) || m.key.toLowerCase().includes(q))
    .slice(0, limit);
}

/** The three long-term-memory tools, bound to one deskmate's scope. */
export function createMemoryTools(deskmateId: string) {
  const remember = defineTool({
    description:
      "Save ONE durable fact or preference that will help in future threads (a WRITE to long-term memory). " +
      "Use a stable `key` (lowercase letters, digits, `_`, `.`, `-`) so re-saving updates the same fact. Never store secrets, tokens, or one-time codes.",
    inputSchema: z.object({
      key: z.string().min(1).max(80).regex(/^[a-z0-9_.-]+$/),
      value: z.string().min(1).max(2000),
      kind: z.enum(["semantic", "episodic"]).default("semantic")
        .describe("semantic = a durable fact; episodic = a dated event"),
      importance: z.number().int().min(1).max(10).default(5),
    }),
    async execute(input, ctx) {
      const store = await resolveMemoryStore();
      return store.put(resolveScope(deskmateId, ctx), input);
    },
  });

  const recall = defineTool({
    description: "Search this deskmate's long-term memory. Omit `query` to list the most relevant memories.",
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(50).default(20) }),
    async execute({ query, limit }, ctx) {
      const store = await resolveMemoryStore();
      // With a query, pull the whole bounded pool so the substring search isn't limited
      // to the top page; without one, the top-`limit` by score is exactly what we want.
      const pool = await store.list(resolveScope(deskmateId, ctx), { limit: query ? POOL_CAP : limit });
      return searchMemories(pool, query, limit);
    },
  });

  const forget = defineTool({
    description: "Delete ONE memory by key from this deskmate's long-term memory.",
    inputSchema: z.object({ key: z.string().min(1).max(80) }),
    approval: always(),
    async execute({ key }, ctx) {
      const store = await resolveMemoryStore();
      return { deleted: await store.delete(resolveScope(deskmateId, ctx), key) };
    },
  });

  return { remember, recall, forget };
}
