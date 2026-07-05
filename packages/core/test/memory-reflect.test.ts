import { describe, it, expect } from "vitest";
import { applyOps, reflectScope, type ReflectionOp } from "../src/memory/reflect.js";
import { buildReflectionPrompt, scheduleReflections } from "../src/memory/schedule.js";
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

describe("buildReflectionPrompt (bounded prompt size)", () => {
  it("serializes at most 50 memories out of 60", () => {
    const memories: Memory[] = Array.from({ length: 60 }, (_, i) => ep(`e${i}`, `value ${i}`));
    const prompt = buildReflectionPrompt(memories);
    // Keys e0..e49 present; e50..e59 dropped.
    expect(prompt).toContain('"e49"');
    expect(prompt).not.toContain('"e50"');
    // Count serialized keys directly from the JSON to be robust.
    const serialized = JSON.parse(prompt.split("\n")[3]) as { key: string }[];
    expect(serialized).toHaveLength(50);
  });

  it("truncates a long value and does not include the full 3000-char string", () => {
    const full = "x".repeat(3000);
    const prompt = buildReflectionPrompt([ep("big", full)]);
    expect(prompt).not.toContain(full);
    expect(prompt).toContain("…"); // truncation marker
    const serialized = JSON.parse(prompt.split("\n")[3]) as { value: string }[];
    expect(serialized[0].value.length).toBeLessThan(full.length);
    expect(serialized[0].value.endsWith("…")).toBe(true);
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

describe("scheduleReflections (failure isolation)", () => {
  it("keeps reflecting other deskmates when one deskmate's reflection throws", async () => {
    const store = createInMemoryStore(() => NOW);
    // 'a' will trigger a throwing reflector; 'b' is healthy.
    await store.put({ deskmate: "a" }, { key: "seed", value: "boom", kind: "episodic", importance: 5 });
    await store.put({ deskmate: "b" }, { key: "seed", value: "ok", kind: "episodic", importance: 5 });

    const reflect = async (items: Memory[]): Promise<ReflectionOp[]> => {
      if (items.some((m) => m.value === "boom")) throw new Error("reflector blew up for a");
      return [{ op: "add", key: "derived", value: "consolidated", importance: 7 }];
    };

    const pending: Promise<unknown>[] = [];
    scheduleReflections(["a", "b"], store, reflect, NOW, (p) => pending.push(p));

    // The whole batch must settle without rejecting (each failure is caught per-id).
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(pending).toHaveLength(2);

    // 'b' was reflected despite 'a' throwing; 'a' is unchanged.
    expect((await store.list({ deskmate: "b" }, { limit: 10 })).some((m) => m.key === "derived")).toBe(true);
    expect((await store.list({ deskmate: "a" }, { limit: 10 })).some((m) => m.key === "derived")).toBe(false);
  });
});
