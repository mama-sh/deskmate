import type { MemoryStore } from "./types.js";
import { createInMemoryStore } from "./adapters/in-memory.js";

export type AdapterKind = "neon" | "in-memory";

/** Pure: decide the adapter from env (unit-tested without touching process.env). */
export function pickAdapterKind(env: Record<string, string | undefined>): AdapterKind {
  return env.DATABASE_URL ? "neon" : "in-memory";
}

let cached: MemoryStore | undefined;
let warned = false;

// Process-wide singleton: resolved once from process.env (which is fixed for the process's
// lifetime), then reused. Kept env-free deliberately — the choice can't change mid-process,
// so a per-call env argument would be silently ignored after the first call.
export async function resolveMemoryStore(): Promise<MemoryStore> {
  if (cached) return cached;
  if (pickAdapterKind(process.env) === "neon") {
    const { createNeonStore } = await import("./adapters/neon.js"); // dynamic → optional dep
    cached = createNeonStore(process.env.DATABASE_URL!);
  } else {
    if (!warned) {
      console.warn("[deskmate:memory] No DATABASE_URL — memory is ephemeral (in-memory adapter).");
      warned = true;
    }
    cached = createInMemoryStore();
  }
  return cached;
}
