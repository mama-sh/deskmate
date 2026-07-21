import { describe, it, expect } from "vitest";
import { isValidId, isValidConnectionName, connectionNameError } from "../src/lib/ids.js";

describe("isValidId (deskmate snake_case identifiers)", () => {
  it("accepts a lowercase letter followed by letters/digits/underscores", () => {
    for (const ok of ["a", "devops", "product_analyst", "x1", "a_b_c"]) {
      expect(isValidId(ok)).toBe(true);
    }
  });
  it("rejects dashes, leading digits, uppercase, and path traversal", () => {
    for (const bad of ["", "1x", "A", "github-write", "../foo", "a.b", " x"]) {
      expect(isValidId(bad)).toBe(false);
    }
  });
});

describe("isValidConnectionName (eve ∩ deskmate intersection — single lowercase word)", () => {
  it("accepts a single lowercase word", () => {
    for (const ok of ["github", "datadog", "a", "mixpanel", "x1"]) {
      expect(isValidConnectionName(ok)).toBe(true);
    }
  });

  it("rejects BOTH dashes (kebab) and underscores (snake) — neither survives both rules", () => {
    // kebab-case: eve-legal, but deskmate-illegal.
    expect(isValidConnectionName("github-write")).toBe(false);
    // snake_case: deskmate-legal, but eve build rejects the underscore in the filename.
    expect(isValidConnectionName("github_write")).toBe(false);
    // other invalids
    for (const bad of ["", "1x", "GitHub", "a.b"]) {
      expect(isValidConnectionName(bad)).toBe(false);
    }
  });
});

describe("connectionNameError", () => {
  it("quotes the offending name and names the eve build conflict", () => {
    const msg = connectionNameError("github_write");
    expect(msg).toContain('"github_write"');
    expect(msg).toContain("single lowercase word");
    expect(msg).toContain("eve build");
  });
});
