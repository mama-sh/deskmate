// The identifier rule for deskmate ids, connection names, and role names: a lowercase
// letter followed by lowercase letters, digits, or underscores. These values become
// directory names, import specifiers, AND filesystem path segments the CLI joins onto
// `cwd` (roles/<id>, connections/<name>) — so a value like "../foo" must be rejected
// BEFORE any fs op (cp/rm), or the CLI could touch paths outside the intended dir.
//
// Mirrors the same rule enforced by `defineTeam` in @deskmate/core; kept CLI-local so
// every CLI command (add/remove/mcp-add) shares one source of truth without importing a
// core internal.
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

/** True when `id` is a safe snake_case identifier (see IDENTIFIER_RE). */
export function isValidId(id: string): boolean {
  return IDENTIFIER_RE.test(id);
}
