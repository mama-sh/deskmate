import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { generateObject } from "ai";
import { z } from "zod";
import type { Memory, MemoryStore } from "./types.js";
import { reflectScope, type Reflector, type ReflectionOp } from "./reflect.js";

export const DEFAULT_MEMORY_REFLECT_CRON = "0 3 * * *"; // nightly "dreaming"
// NOTE: verify this id resolves on the Vercel AI Gateway; runs once per deskmate per night, so keep it cheap.
export const DEFAULT_REFLECT_MODEL = "anthropic/claude-haiku-4.5";

const OpsSchema = z.object({
  ops: z.array(z.object({
    op: z.enum(["add", "merge", "supersede"]),
    key: z.string().min(1).max(80).regex(/^[a-z0-9_.-]+$/),
    value: z.string().min(1).max(2000),
    importance: z.number().int().min(1).max(10).optional(),
  })).max(50),
});

// Bound the reflection prompt so it can't blow the model's context/cost: a full pool is up
// to 200 memories × 2000 chars each. We cap the count and truncate each value. The input is
// already score-ordered (from store.list), so slicing keeps the most relevant memories.
const REFLECT_MAX_ITEMS = 50;
const REFLECT_VALUE_CHARS = 500;

const truncateValue = (value: string): string =>
  value.length > REFLECT_VALUE_CHARS ? value.slice(0, REFLECT_VALUE_CHARS) + "…" : value;

export function buildReflectionPrompt(memories: Memory[]): string {
  const bounded = memories
    .slice(0, REFLECT_MAX_ITEMS)
    .map(({ key, value, kind, importance }) => ({ key, value: truncateValue(value), kind, importance }));
  return [
    "You are consolidating one AI coworker's long-term memory during idle time ('dreaming').",
    "Below are its current memories as JSON (kind: 'episodic' = a raw event; 'semantic' = a durable fact).",
    "",
    JSON.stringify(bounded),
    "",
    "Propose a SMALL set of CONSERVATIVE, high-confidence consolidation operations:",
    "- add: a new SEMANTIC fact synthesized from one or more episodic events (use a fresh snake_case key).",
    "- merge: rewrite an existing SEMANTIC memory to fold in a near-duplicate (reuse its key).",
    "- supersede: replace an outdated SEMANTIC fact with the correction (reuse its key, low importance if retiring).",
    "Rules: NEVER propose deleting or rewriting an 'episodic' memory — raw events are immutable.",
    "Only act when confident; prefer returning few or no ops over speculative ones. Output the ops array.",
  ].join("\n");
}

/** Default reflector backed by a cheap model. `gen` is injectable so tests never hit a real model. */
export function makeModelReflector(model = DEFAULT_REFLECT_MODEL, gen: typeof generateObject = generateObject): Reflector {
  return async (memories) => {
    if (memories.length === 0) return [];
    try {
      const { object } = await gen({ model, schema: OpsSchema, prompt: buildReflectionPrompt(memories) } as any);
      return (object as { ops: ReflectionOp[] }).ops;
    } catch {
      return []; // fail-closed: skip consolidation this run
    }
  };
}

/** The nightly reflection ("dreaming") schedule. Codegen passes the memory-enabled deskmate ids. */
export function createMemoryReflection(
  deskmateIds: string[],
  store: MemoryStore,
  opts: { cron?: string; model?: string; reflect?: Reflector } = {},
) {
  const reflect = opts.reflect ?? makeModelReflector(opts.model);
  return defineSchedule({
    cron: opts.cron ?? DEFAULT_MEMORY_REFLECT_CRON,
    async run({ waitUntil }: ScheduleHandlerArgs) {
      waitUntil(
        Promise.all(deskmateIds.map((id) => reflectScope(store, { deskmate: id }, reflect, { maxItems: 200, now: Date.now() }))),
      );
    },
  });
}
