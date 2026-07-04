import { describe, it, expect } from "vitest";
import { applyOps, reflectScope, type ReflectionOp } from "../src/memory/reflect.js";
import { createInMemoryStore } from "../src/memory/adapters/in-memory.js";
import type { Memory } from "../src/memory/types.js";

const NOW = 1_000_000_000_000;
const ep = (key: string, value: string): Memory => ({
  key, value, kind: "episodic", importance: 5,
  createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
});

describe("applyOps (additive, conservative)", () => {
  it("adds synthesized semantic facts without deleting episodic sources", () => {
    const items = [ep("e1", "acme filed 3 latency tickets"), ep("e2", "acme asked about SLAs")];
    const ops: ReflectionOp[] = [{ op: "add", key: "acme_churn_risk", value: "Acme is a latency-driven churn risk", importance: 9 }];
    const out = applyOps(items, ops, { maxItems: 200, now: NOW });
    expect(out.find((m) => m.key === "acme_churn_risk")?.kind).toBe("semantic");
    expect(out.filter((m) => m.kind === "episodic").map((m) => m.key).sort()).toEqual(["e1", "e2"]);
  });
  it("merge rewrites the target but keeps other memories", () => {
    const items = [ep("e1", "x"), { ...ep("s1", "old fact"), kind: "semantic" as const }];
    const ops: ReflectionOp[] = [{ op: "merge", key: "s1", value: "clarified fact", importance: 8 }];
    const out = applyOps(items, ops, { maxItems: 200, now: NOW });
    expect(out.find((m) => m.key === "s1")?.value).toBe("clarified fact");
    expect(out.some((m) => m.key === "e1")).toBe(true);
  });
  it("ignores supersede ops on episodic memories (never destroys raw)", () => {
    const items = [ep("e1", "raw event")];
    const ops: ReflectionOp[] = [{ op: "supersede", key: "e1", value: "n/a", importance: 1 }];
    const out = applyOps(items, ops, { maxItems: 200, now: NOW });
    expect(out.some((m) => m.key === "e1")).toBe(true);
    expect(out.find((m) => m.key === "e1")?.kind).toBe("episodic");
  });
});

describe("reflectScope", () => {
  it("applies additive ops to the store and protects episodic at the store level", async () => {
    const store = createInMemoryStore(() => NOW);
    await store.put({ deskmate: "cs" }, { key: "e1", value: "raw event", kind: "episodic", importance: 5 });
    const reflect = async (): Promise<ReflectionOp[]> => [
      { op: "add", key: "fact", value: "synthesized", importance: 8 },
      { op: "supersede", key: "e1", value: "x", importance: 1 },
    ];
    const applied = await reflectScope(store, { deskmate: "cs" }, reflect, { maxItems: 200, now: NOW });
    const items = await store.list({ deskmate: "cs" }, { limit: 10 });
    expect(items.find((m) => m.key === "fact")?.kind).toBe("semantic");
    expect(items.find((m) => m.key === "e1")?.kind).toBe("episodic"); // supersede skipped on episodic
    expect(applied).toBe(1); // only the add was applied; the episodic supersede was skipped
  });
});
