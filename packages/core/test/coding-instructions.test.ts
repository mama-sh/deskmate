import { describe, it, expect } from "vitest";
import { createCodingInstructions } from "../src/coding/instructions.js";

describe("createCodingInstructions", () => {
  const md = createCodingInstructions();

  it("states the safety hard rules", () => {
    expect(md).toMatch(/never\b.*\bdefault branch/i);
    expect(md).toMatch(/never merge/i);
    expect(md).toMatch(/open_pull_request/);
  });

  it("describes the feature-branch + PR loop", () => {
    expect(md).toMatch(/deskmate\/<id>\/<slug>|feature branch/i);
    expect(md).toMatch(/pull request|\bPR\b/);
    expect(md).toMatch(/test/i);
  });

  it("is non-trivial prose", () => {
    expect(md.length).toBeGreaterThan(300);
  });
});
