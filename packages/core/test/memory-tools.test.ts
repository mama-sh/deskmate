import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/memory/scope.js";

describe("resolveScope", () => {
  it("uses the injected deskmate id, ignoring any model-supplied value", () => {
    const scope = resolveScope("cs", { session: {} } as any);
    expect(scope.deskmate).toBe("cs");
  });
  it("derives workspace from the Slack session auth team_id (mention/DM path)", () => {
    const scope = resolveScope("cs", { session: { auth: { current: { attributes: { team_id: "T1" } } } } } as any);
    expect(scope.workspace).toBe("T1");
  });
  it("derives workspace from the ambient channel's teamId attribute", () => {
    const scope = resolveScope("cs", { session: { auth: { current: { attributes: { teamId: "T2" } } } } } as any);
    expect(scope.workspace).toBe("T2");
  });
  it("leaves workspace undefined when absent", () => {
    expect(resolveScope("cs", {} as any).workspace).toBeUndefined();
  });
});
