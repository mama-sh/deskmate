import { describe, it, expect } from "vitest";
import { pickAdapterKind } from "../src/memory/store.js";

describe("pickAdapterKind", () => {
  it("uses neon when DATABASE_URL is set", () => {
    expect(pickAdapterKind({ DATABASE_URL: "postgres://x" })).toBe("neon");
  });
  it("falls back to in-memory when unset", () => {
    expect(pickAdapterKind({})).toBe("in-memory");
  });
});
