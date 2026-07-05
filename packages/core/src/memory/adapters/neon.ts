import type { NeonQueryFunction } from "@neondatabase/serverless";
import type { Memory, MemoryInput, MemoryScope, MemoryStore } from "../types.js";
import { applyPut } from "../apply.js";
import { scoreMemory } from "../score.js";

const MAX = 200;

/** undefined workspace maps to the literal '_', matching the in-memory adapter's scoping. */
const ws = (s: MemoryScope): string => s.workspace ?? "_";

/** A single row of the `memories` table. */
export interface MemoryRow {
  workspace: string;
  deskmate: string;
  key: string;
  value: string;
  kind: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

/** Pure: Memory + scope -> DB row. */
export function memoryToRow(scope: MemoryScope, m: Memory): MemoryRow {
  return {
    workspace: ws(scope),
    deskmate: scope.deskmate,
    key: m.key,
    value: m.value,
    kind: m.kind,
    importance: m.importance,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

/** Pure: DB row -> Memory. Coerces timestamps (Date or string from the driver) to ISO. */
export function rowToMemory(row: MemoryRow): Memory {
  return {
    key: row.key,
    value: row.value,
    kind: row.kind as Memory["kind"],
    importance: Number(row.importance),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type Sql = NeonQueryFunction<false, false>;

/**
 * Durable Postgres MemoryStore backed by Neon's serverless HTTP driver.
 *
 * `@neondatabase/serverless` is an OPTIONAL peer dependency, imported dynamically
 * inside this factory so it is only loaded when a Neon store is actually created.
 * Behavior mirrors the in-memory adapter (same `applyPut` eviction, same
 * score-ordered reads) so swapping backends changes durability only.
 */
export function createNeonStore(connectionString: string): MemoryStore {
  let ready: Promise<Sql> | undefined;

  // Memoized so the CREATE TABLE runs at most once per store, even under concurrent calls.
  // A FAILED init clears the memo so the next call retries — otherwise a single transient
  // failure (rejected promise) would be cached forever and permanently brick the store.
  const getSql = (): Promise<Sql> => {
    if (!ready) {
      ready = (async () => {
        const { neon } = await import("@neondatabase/serverless");
        const sql = neon(connectionString);
        await sql`CREATE TABLE IF NOT EXISTS memories (
          workspace text not null default '_',
          deskmate text not null,
          key text not null,
          value text not null,
          kind text not null,
          importance int not null,
          created_at timestamptz not null,
          updated_at timestamptz not null,
          primary key (workspace, deskmate, key)
        )`;
        return sql;
      })().catch((e) => {
        ready = undefined; // failed init retries on the next call
        throw e;
      });
    }
    return ready;
  };

  const fetchScope = async (sql: Sql, scope: MemoryScope): Promise<Memory[]> => {
    const rows = (await sql`
      SELECT workspace, deskmate, key, value, kind, importance, created_at, updated_at
      FROM memories
      WHERE workspace = ${ws(scope)} AND deskmate = ${scope.deskmate}
    `) as unknown as MemoryRow[];
    return rows.map(rowToMemory);
  };

  return {
    async list(scope, { limit }) {
      const sql = await getSql();
      const now = Date.now();
      const items = await fetchScope(sql, scope);
      return items
        .sort((a, b) => scoreMemory(b, now) - scoreMemory(a, now))
        .slice(0, limit);
    },

    async put(scope, input: MemoryInput) {
      const sql = await getSql();
      const now = Date.now();

      // 1. Fetch ONLY the existing row for this key (if any) — not the whole scope.
      const existingRows = (await sql.query(
        `SELECT workspace, deskmate, key, value, kind, importance, created_at, updated_at
         FROM memories
         WHERE workspace = $1 AND deskmate = $2 AND key = $3`,
        [ws(scope), scope.deskmate, input.key],
      )) as unknown as MemoryRow[];

      // 2. Normalize the new row via applyPut over just that one existing row — reusing its
      //    createdAt-preservation, importance clamp, and kind default. With ≤ maxItems inputs
      //    no eviction happens here, so the result always contains input.key.
      const normalized = applyPut(existingRows.map(rowToMemory), input, { maxItems: MAX, now }).find(
        (m) => m.key === input.key,
      )!;
      const r = memoryToRow(scope, normalized);

      // 3. UPSERT the single normalized row. All values are bound parameters (injection-safe).
      await sql.query(
        `INSERT INTO memories (workspace, deskmate, key, value, kind, importance, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace, deskmate, key) DO UPDATE SET
           value = EXCLUDED.value,
           kind = EXCLUDED.kind,
           importance = EXCLUDED.importance,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at`,
        [r.workspace, r.deskmate, r.key, r.value, r.kind, r.importance, r.created_at, r.updated_at],
      );

      // 4. Self-contained eviction: keep the top-MAX by a score expression that mirrors
      //    scoreMemory (importance + RECENCY_WEIGHT/(1+ageDays), RECENCY_WEIGHT=5, ageDays in
      //    days) so Neon eviction matches the in-memory adapter, and delete the rest. It runs
      //    entirely against the LIVE table in one statement (no pre-write snapshot), so it can
      //    never delete a concurrent writer's row that legitimately ranks in the top-MAX.
      await sql.query(
        `DELETE FROM memories
         WHERE workspace = $1 AND deskmate = $2
           AND key NOT IN (
             SELECT key FROM memories
             WHERE workspace = $1 AND deskmate = $2
             ORDER BY (importance + 5.0 / (1 + EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400.0)) DESC
             LIMIT $3
           )`,
        [ws(scope), scope.deskmate, MAX],
      );

      return normalized;
    },

    async delete(scope, key) {
      const sql = await getSql();
      const rows = (await sql.query(
        `DELETE FROM memories
         WHERE workspace = $1 AND deskmate = $2 AND key = $3
         RETURNING key`,
        [ws(scope), scope.deskmate, key],
      )) as unknown as unknown[];
      return rows.length > 0;
    },

    async listScopes() {
      const sql = await getSql();
      const rows = (await sql`
        SELECT DISTINCT workspace, deskmate FROM memories
      `) as unknown as { workspace: string; deskmate: string }[];
      return rows.map((r) => ({ workspace: r.workspace, deskmate: r.deskmate }));
    },
  };
}
