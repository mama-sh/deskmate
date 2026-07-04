import { readFileSync } from "node:fs";

// The front-desk router instructions template. `deskmate sync` writes this into
// the generated `agent/instructions.md`. It is kept as a sibling `.md` asset (read
// at import time) rather than an inline template literal so the prose — which is
// dense with backticks (`deskmate_says`, `[routing]`, `tag`, …) — stays byte-for-byte
// faithful to the authored source with zero escaping.
export const frontDeskInstructions: string = readFileSync(
  new URL("./front-desk-instructions.md", import.meta.url),
  "utf8",
);
