import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { remove } from "../src/remove.js";

// `remove` joins the given id onto `roles/` and rmSync's it. An id like "../foo"
// would normalize to a path OUTSIDE roles/ — this test proves the up-front id guard
// blocks that before any filesystem op, while a valid id still deletes roles/<id>.

let cwd: string;
let priorExitCode: typeof process.exitCode;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "deskmate-remove-"));
  priorExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  process.exitCode = priorExitCode;
});

describe("deskmate remove — id guard", () => {
  it("refuses a traversal id and deletes nothing outside roles/, exiting non-zero", () => {
    // `join(cwd, "roles", "../foo")` normalizes to `cwd/foo` — OUTSIDE roles/.
    const outside = join(cwd, "foo");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "do not delete me");

    remove(["../foo"], cwd);

    expect(existsSync(outside)).toBe(true); // untouched
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(process.exitCode).toBe(1); // non-zero exit
  });

  it("refuses other non-identifier ids up front", () => {
    for (const bad of ["../../etc", "Bad-Id", "with space", ".hidden"]) {
      process.exitCode = 0;
      // No roles/ dir exists; the guard must fire before any fs op regardless.
      remove([bad], cwd);
      expect(process.exitCode).toBe(1);
    }
  });

  it("still removes a valid roles/<id> directory", () => {
    const dest = join(cwd, "roles", "devops");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "deskmate.json"), "{}");

    remove(["devops"], cwd);

    expect(existsSync(dest)).toBe(false); // deleted
    expect(process.exitCode).toBe(0); // no error for a valid id
  });
});
