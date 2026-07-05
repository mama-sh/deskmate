import { describe, it, expect } from "vitest";
import {
  memoryToRow,
  rowToMemory,
  createNeonStore,
  type MemoryRow,
} from "../src/memory/adapters/neon.js";
import type { Memory, MemoryScope } from "../src/memory/types.js";

describe("neon row mapping (pure, no DB)", () => {
  it("round-trips a Memory through rowToMemory(memoryToRow(scope, m))", () => {
    const scope: MemoryScope = { deskmate: "cs", workspace: "T1" };
    // Fixed, already-normalized ISO values survive `new Date(...).toISOString()`.
    const m: Memory = {
      key: "prefers-dark-mode",
      value: "The user prefers dark mode.",
      kind: "semantic",
      importance: 7,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-05T12:30:00.000Z",
    };
    expect(rowToMemory(memoryToRow(scope, m))).toEqual(m);
  });

  it("maps undefined workspace to the literal '_'", () => {
    const scope: MemoryScope = { deskmate: "cs" };
    const m: Memory = {
      key: "a",
      value: "x",
      kind: "episodic",
      importance: 3,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-04T00:00:00.000Z",
    };
    expect(memoryToRow(scope, m).workspace).toBe("_");
  });

  it("carries scope + Memory fields onto the row", () => {
    const scope: MemoryScope = { deskmate: "devops", workspace: "T2" };
    const m: Memory = {
      key: "k",
      value: "v",
      kind: "semantic",
      importance: 5,
      createdAt: "2026-07-04T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    };
    expect(memoryToRow(scope, m)).toEqual<MemoryRow>({
      workspace: "T2",
      deskmate: "devops",
      key: "k",
      value: "v",
      kind: "semantic",
      importance: 5,
      created_at: "2026-07-04T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
    });
  });

  it("coerces a Date-typed timestamp from the driver to ISO", () => {
    // The HTTP driver may return timestamptz as a Date; rowToMemory must normalize it.
    const row = {
      workspace: "_",
      deskmate: "cs",
      key: "k",
      value: "v",
      kind: "semantic",
      importance: 4,
      created_at: new Date("2026-07-04T00:00:00.000Z"),
      updated_at: new Date("2026-07-05T00:00:00.000Z"),
    } as unknown as MemoryRow;
    const m = rowToMemory(row);
    expect(m.createdAt).toBe("2026-07-04T00:00:00.000Z");
    expect(m.updatedAt).toBe("2026-07-05T00:00:00.000Z");
  });

  it("coerces a string importance from the driver to a number", () => {
    const row = {
      workspace: "_",
      deskmate: "cs",
      key: "k",
      value: "v",
      kind: "semantic",
      importance: "8",
      created_at: "2026-07-04T00:00:00.000Z",
      updated_at: "2026-07-04T00:00:00.000Z",
    } as unknown as MemoryRow;
    expect(rowToMemory(row).importance).toBe(8);
  });
});

// Live integration test: only runs when DATABASE_URL is set (skipped in CI).
describe.skipIf(!process.env.DATABASE_URL)("neon store (live DB)", () => {
  it("put/list/delete round-trips against a real database", async () => {
    const store = createNeonStore(process.env.DATABASE_URL!);
    const scope: MemoryScope = {
      deskmate: "cs",
      workspace: `test-${Date.now()}`,
    };
    try {
      const put = await store.put(scope, {
        key: "greeting",
        value: "hello",
        importance: 6,
      });
      expect(put.key).toBe("greeting");
      expect(put.value).toBe("hello");

      const list = await store.list(scope, { limit: 10 });
      expect(list.map((m) => m.key)).toEqual(["greeting"]);

      expect(await store.delete(scope, "greeting")).toBe(true);
      expect(await store.delete(scope, "greeting")).toBe(false);
      expect(await store.list(scope, { limit: 10 })).toEqual([]);
    } finally {
      await store.delete(scope, "greeting");
    }
  });
});
