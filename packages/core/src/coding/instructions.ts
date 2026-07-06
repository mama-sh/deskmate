import { readFileSync } from "node:fs";

// The coding safety-rules block, injected as a subagent instructions/* module for
// any deskmate with `coding` enabled (so the rules hold even if a role's own
// instructions.md is terse). Kept as a sibling `.md` read at import time — like
// house-style.md — so the prose stays byte-for-byte faithful with zero escaping.
// The core build copies this .md into dist/coding/ alongside the compiled output.
const codingInstructions: string = readFileSync(
  new URL("./instructions.md", import.meta.url),
  "utf8",
);

export function createCodingInstructions(): string {
  return codingInstructions;
}
