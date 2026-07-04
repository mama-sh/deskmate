import { escapeRegExp } from "./lib/env.js";

// Dumb, well-tested string transforms over a `deskmate.config.ts` source. These
// are deliberately NOT a full AST: they locate the `deskmates: { … }` (or
// `connections: { … }`) object by brace-matching and splice a key in/out. Good
// enough for the config shapes the CLI itself writes; a consumer with an exotic
// hand-authored config falls back to the printed snippet (see add.ts).

type Entry = Record<string, unknown>;

/** Locate the `{ … }` object that follows `<containerKey>:`, by brace-matching. */
function findObjectSpan(source: string, containerKey: string): { open: number; close: number } | null {
  const re = new RegExp(`${escapeRegExp(containerKey)}\\s*:\\s*\\{`);
  const m = re.exec(source);
  if (!m) return null;
  const open = m.index + m[0].length - 1; // index of the opening '{'
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { open, close: i };
    }
  }
  return null;
}

/**
 * True when `entryKey` appears as a TOP-LEVEL key of the object region `inner`
 * (brace depth 0 from the start of `inner`). A NESTED field of the same name does
 * NOT count — otherwise inserting a new top-level entry whose name collides with a
 * nested field (e.g. adding `connections.env` when a connection already has an
 * `env: "…"` field) would be wrongly skipped as "already present", leaving the
 * config unwired. Mirrors the depth scan in `removeObjectEntry`.
 */
function hasKey(inner: string, entryKey: string): boolean {
  const keyRe = new RegExp(`(^|[{,\\n])\\s*["']?${escapeRegExp(entryKey)}["']?\\s*:`, "gm");
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(inner))) {
    const before = inner.slice(0, m.index);
    const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    if (depth === 0) return true; // top-level key of the container
  }
  return false;
}

/** Leading whitespace of the source line that `index` sits on. */
function lineIndent(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return source.slice(lineStart, index).match(/^\s*/)?.[0] ?? "";
}

/** Render `<key>: { … },` at the given base indent (the indent of the container key). */
export function renderEntry(key: string, entry: Entry, baseIndent = "  "): string {
  const keyIndent = `${baseIndent}  `;
  const fieldIndent = `${keyIndent}  `;
  const fields = Object.entries(entry)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${fieldIndent}${k}: ${JSON.stringify(v)},`)
    .join("\n");
  return `${keyIndent}${key}: {\n${fields}\n${keyIndent}},`;
}

/**
 * Insert `<entryKey>: { …entry }` into the `<containerKey>: { … }` object.
 * Idempotent: if the key already exists, returns `source` unchanged.
 * Throws if the container object cannot be found.
 */
function insertObjectEntry(source: string, containerKey: string, entryKey: string, entry: Entry): string {
  const span = findObjectSpan(source, containerKey);
  if (!span) throw new Error(`could not find a \`${containerKey}: { … }\` object in the config`);
  const inner = source.slice(span.open + 1, span.close);
  if (hasKey(inner, entryKey)) return source; // idempotent no-op

  const baseIndent = lineIndent(source, span.open);
  const text = renderEntry(entryKey, entry, baseIndent);

  // Insert right after the opening brace (prepend). For a non-empty object the
  // original `\n<indent>existingKey…` follows, so the result stays well-formed.
  const insertAt = span.open + 1;
  const emptyObject = /^\s*\}/.test(source.slice(insertAt));
  const insertion = emptyObject ? `\n${text}\n${baseIndent}` : `\n${text}`;
  return source.slice(0, insertAt) + insertion + source.slice(insertAt);
}

/** Remove a top-level `<entryKey>: …,` from `<containerKey>: { … }`. No-op if absent. */
function removeObjectEntry(source: string, containerKey: string, entryKey: string): string {
  const span = findObjectSpan(source, containerKey);
  if (!span) return source;
  const keyRe = new RegExp(`["']?${escapeRegExp(entryKey)}["']?\\s*:`, "g");
  keyRe.lastIndex = span.open + 1;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(source)) && m.index < span.close) {
    // Only remove a *top-level* key of the container (brace depth 0 from open).
    const before = source.slice(span.open + 1, m.index);
    const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    if (depth !== 0) continue;

    let i = m.index + m[0].length;
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source[i] === "{") {
      let d = 0;
      for (; i < source.length; i++) {
        if (source[i] === "{") d++;
        else if (source[i] === "}") {
          d--;
          if (d === 0) {
            i++;
            break;
          }
        }
      }
    } else {
      while (i < source.length && source[i] !== "," && i < span.close) i++;
    }
    // Consume a trailing comma on the same line.
    let end = i;
    while (end < source.length && source[end] !== "\n" && /\s/.test(source[end]!)) end++;
    if (source[end] === ",") end++;
    // Consume the key's leading indent, and the newline before it, so no blank
    // line is left behind.
    let start = m.index;
    while (start > 0 && source[start - 1] !== "\n" && /\s/.test(source[start - 1]!)) start--;
    if (source[start - 1] === "\n") start--;
    return source.slice(0, start) + source.slice(end);
  }
  return source;
}

/** Insert a deskmate entry into `deskmates: { … }`. Idempotent; throws if not found. */
export function appendDeskmateEntry(configSource: string, id: string, entry: Entry): string {
  return insertObjectEntry(configSource, "deskmates", id, entry);
}

/** Insert a connection entry into `connections: { … }`. Idempotent; throws if not found. */
export function appendConnectionEntry(configSource: string, name: string, entry: Entry): string {
  return insertObjectEntry(configSource, "connections", name, entry);
}

/** Remove a deskmate entry from `deskmates: { … }`. No-op if absent. */
export function removeDeskmateEntry(configSource: string, id: string): string {
  return removeObjectEntry(configSource, "deskmates", id);
}
