import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCatalogRoot } from "./catalog.js";
import { appendConnectionEntry, appendDeskmateEntry, renderEntry } from "./config-file.js";

export const CONFIG_FILE = "deskmate.config.ts";

type RoleIdentity = {
  id: string;
  displayName: string;
  emoji: string;
  summary: string;
  skill?: string;
  providers?: string[];
};

export function readRole(roleDir: string): RoleIdentity {
  return JSON.parse(readFileSync(join(roleDir, "deskmate.json"), "utf8")) as RoleIdentity;
}

/** The `deskmates.<id>` config entry derived from a role's deskmate.json. */
export function entryFromRole(role: RoleIdentity): Record<string, unknown> {
  return {
    role: role.id,
    emoji: role.emoji,
    displayName: role.displayName,
    summary: role.summary,
    ...(role.skill ? { skill: role.skill } : {}),
    reads: role.providers ?? [],
  };
}

/**
 * Apply a config edit to `./deskmate.config.ts`, printing a paste-able snippet
 * as a graceful fallback when the file is missing or can't be edited safely.
 */
export function editConfig(
  cwd: string,
  label: string,
  transform: (src: string) => string,
  snippet: string,
  noopMessage = `${label}: no change to ${CONFIG_FILE}`,
): void {
  const configPath = join(cwd, CONFIG_FILE);
  if (!existsSync(configPath)) {
    console.log(`… no ${CONFIG_FILE} found. Add ${label} to your config by hand:\n\n${snippet}\n`);
    return;
  }
  const src = readFileSync(configPath, "utf8");
  try {
    const next = transform(src);
    if (next === src) {
      console.log(`• ${noopMessage}`);
      return;
    }
    writeFileSync(configPath, next);
    console.log(`✓ updated ${CONFIG_FILE} (${label})`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`… couldn't edit ${CONFIG_FILE} safely (${reason}). Add ${label} by hand:\n\n${snippet}\n`);
  }
}

/**
 * `deskmate add <id...>`: copy each catalog role into the consumer's editable
 * `./roles/<id>` (skip if already there), then append a `deskmates.<id>` entry
 * to `./deskmate.config.ts` (or print it if the config can't be edited).
 */
export function add(ids: string[], cwd: string = process.cwd()): void {
  const catalog = resolveCatalogRoot();
  for (const id of ids) {
    const src = join(catalog, "roles", id);
    if (!existsSync(join(src, "deskmate.json"))) {
      console.error(`✗ ${id}: not in the catalog. Run \`deskmate list\`.`);
      process.exitCode = 1;
      continue;
    }
    const role = readRole(src);
    const dest = join(cwd, "roles", id);
    if (existsSync(dest)) {
      console.log(`• ${id}: roles/${id} already present, skipping copy`);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      console.log(`✓ copied roles/${id}`);
    }
    const entry = entryFromRole(role);
    editConfig(
      cwd,
      id,
      (s) => appendDeskmateEntry(s, id, entry),
      renderEntry(id, entry),
      `${id}: already in ${CONFIG_FILE}`,
    );

    // Seed a matching `connections.<provider>` for each provider the role reads —
    // without it `defineTeam` rejects the `reads` value as an unknown connection,
    // so the documented `deskmate add … && deskmate sync` would fail. Idempotent:
    // an already-present connection is left untouched (its env prefix is kept).
    const providers = role.providers ?? [];
    for (const provider of providers) {
      const env = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const connEntry = { kind: "mcp", env };
      editConfig(
        cwd,
        `connections.${provider}`,
        (s) => appendConnectionEntry(s, provider, connEntry),
        renderEntry(provider, connEntry),
        `${provider}: already in connections`,
      );
    }
    if (providers.length) {
      const prefixes = providers
        .map((p) => `${p} (${p.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_MCP_URL/_TOKEN)`)
        .join(", ");
      console.log(
        `  seeded connection(s): ${prefixes} — set those env vars, or edit the env prefix in ${CONFIG_FILE}.`,
      );
    }
  }
}
