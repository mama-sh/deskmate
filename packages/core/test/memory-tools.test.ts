import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/memory/scope.js";

describe("resolveScope", () => {
  it("uses the injected deskmate id, ignoring any model-supplied value", () => {
    const scope = resolveScope("cs", { session: {} } as any);
    expect(scope.deskmate).toBe("cs");
  });
  it("derives workspace from channel metadata when present", () => {
    const scope = resolveScope("cs", { channel: { metadata: { teamId: "T1" } } } as any);
    expect(scope.workspace).toBe("T1");
  });
  it("leaves workspace undefined when absent", () => {
    expect(resolveScope("cs", {} as any).workspace).toBeUndefined();
  });
});
