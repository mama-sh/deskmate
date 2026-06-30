import { describe, it, expect } from "vitest";
import { mergeEnv } from "../scripts/lib/env.js";

describe("mergeEnv", () => {
  it("appends new keys with a trailing newline", () => {
    expect(mergeEnv("", { A: "1" })).toBe("A=1\n");
    expect(mergeEnv("A=1", { B: "2" })).toBe("A=1\nB=2\n");
  });
  it("replaces an existing key in place, leaving others", () => {
    expect(mergeEnv("A=old\nB=2\n", { A: "new" })).toBe("A=new\nB=2\n");
  });
  it("preserves $ in values (secrets) on both append and replace paths", () => {
    // Append path (concatenation) is already safe; replace path must not treat
    // the value as a regex replacement string ($&, $$, $1 are special there).
    expect(mergeEnv("", { TOKEN: "ab$$cd" })).toBe("TOKEN=ab$$cd\n");
    expect(mergeEnv("TOKEN=old\nB=2\n", { TOKEN: "p$&w" })).toBe("TOKEN=p$&w\nB=2\n");
  });
});
