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
  const getSql = (): Promise<Sql> =>
    (ready ??= (async () => {
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
    })());

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
      const current = await fetchScope(sql, scope);
      const result = applyPut(current, input, { maxItems: MAX, now: Date.now() });

      // Reconcile the DB to match `result`.
      // UPSERT every result row in a single round-trip. The $N placeholders are
      // generated from loop indices (never user data); all values are bound
      // parameters, so this is injection-safe.
      const COLS = 8;
      const params: unknown[] = [];
      const tuples = result.map((m, i) => {
        const r = memoryToRow(scope, m);
        params.push(
          r.workspace,
          r.deskmate,
          r.key,
          r.value,
          r.kind,
          r.importance,
          r.created_at,
          r.updated_at,
        );
        const b = i * COLS;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
      });
      await sql.query(
        `INSERT INTO memories (workspace, deskmate, key, value, kind, importance, created_at, updated_at)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (workspace, deskmate, key) DO UPDATE SET
           value = EXCLUDED.value,
           kind = EXCLUDED.kind,
           importance = EXCLUDED.importance,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at`,
        params,
      );

      // DELETE any rows for this scope whose key is no longer present (evictions).
      // `result` always contains `input.key`, so the key list is non-empty.
      const keys = result.map((m) => m.key);
      await sql.query(
        `DELETE FROM memories
         WHERE workspace = $1 AND deskmate = $2 AND NOT (key = ANY($3::text[]))`,
        [ws(scope), scope.deskmate, keys],
      );

      return result.find((m) => m.key === input.key)!;
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
  };
}
