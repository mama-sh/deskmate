import { describe, it, expect } from "vitest";
import { createInMemoryStore } from "../src/memory/adapters/in-memory.js";

describe("in-memory store", () => {
  it("put/list round-trips within a scope", async () => {
    const s = createInMemoryStore(() => 1_000);
    await s.put({ deskmate: "cs" }, { key: "a", value: "hi" });
    const list = await s.list({ deskmate: "cs" }, { limit: 10 });
    expect(list.map((m) => m.key)).toEqual(["a"]);
  });
  it("isolates deskmates from each other", async () => {
    const s = createInMemoryStore(() => 1_000);
    await s.put({ deskmate: "cs" }, { key: "a", value: "x" });
    expect(await s.list({ deskmate: "devops" }, { limit: 10 })).toEqual([]);
  });
  it("isolates workspaces from each other", async () => {
    const s = createInMemoryStore(() => 1_000);
    await s.put({ deskmate: "cs", workspace: "T1" }, { key: "a", value: "x" });
    expect(await s.list({ deskmate: "cs", workspace: "T2" }, { limit: 10 })).toEqual([]);
  });
  it("delete removes and reports", async () => {
    const s = createInMemoryStore(() => 1_000);
    await s.put({ deskmate: "cs" }, { key: "a", value: "x" });
    expect(await s.delete({ deskmate: "cs" }, "a")).toBe(true);
    expect(await s.delete({ deskmate: "cs" }, "a")).toBe(false);
  });
  it("listScopes returns the distinct (workspace, deskmate) scopes holding memories", async () => {
    const s = createInMemoryStore(() => 1_000);
    await s.put({ deskmate: "a", workspace: "T1" }, { key: "k", value: "x" });
    await s.put({ deskmate: "b", workspace: "T1" }, { key: "k", value: "x" });
    await s.put({ deskmate: "a" }, { key: "k", value: "x" }); // no workspace → "_"
    const scopes = await s.listScopes();
    const sorted = [...scopes].sort((x, y) =>
      `${x.workspace}:${x.deskmate}`.localeCompare(`${y.workspace}:${y.deskmate}`),
    );
    expect(sorted).toEqual([
      { workspace: "_", deskmate: "a" },
      { workspace: "T1", deskmate: "a" },
      { workspace: "T1", deskmate: "b" },
    ]);
  });
});
