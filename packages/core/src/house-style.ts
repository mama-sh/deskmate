import { readFileSync } from "node:fs";

// The shared "house style" block: how every deskmate should write (voice) and work
// (grounding, clarifying questions). `deskmate sync` composes this UNDER each
// deskmate's role instructions when generating `agent/subagents/<id>/instructions.md`,
// so the voice is authored once here instead of copy-pasted into every role. Kept as
// a sibling `.md` (read at import time), like the front-desk template, so the prose —
// dense with backticks and em-dash examples — stays byte-for-byte faithful with zero
// escaping. Exposed on its own subpath export so importing it doesn't pull core's
// runtime graph.
export const houseStyle: string = readFileSync(
  new URL("./house-style.md", import.meta.url),
  "utf8",
);
