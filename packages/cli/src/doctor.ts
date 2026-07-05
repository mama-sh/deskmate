import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadTeam as realLoadTeam } from "./lib/load-config.js";
import { probeMcp } from "./lib/mcp-probe.js";
import type { TeamConfig } from "@deskmate/core";
import type { ProbeResult } from "./lib/mcp-probe.js";

export type ResolvedConn =
  | { kind: "not-found" }
  | { kind: "unconfigured"; url: string }
  | { kind: "error"; message: string } // the authored file couldn't be imported (syntax error, bad definition, …)
  | { kind: "ready"; url: string; headers: Record<string, string>; allow: string[] };

export interface DoctorDeps {
  loadTeam: (cwd: string) => Promise<TeamConfig>;
  resolveConnection: (name: string, cwd: string) => Promise<ResolvedConn>;
  probe: (url: string, headers: Record<string, string>) => Promise<ProbeResult>;
  /** Load the pulled Vercel env into process.env; returns the file loaded, or null. */
  loadEnv: (cwd: string) => string | null;
}

/**
 * Best-effort: load the pulled Vercel env into `process.env` so doctor checks the REAL
 * production env. `vercel env pull` only WRITES `.vercel/.env.production.local`; a fresh
 * `deskmate doctor` process wouldn't otherwise see it, so every connection would read as
 * `example.invalid` and the gate would pass green having probed nothing. Loads the first
 * file that exists (production first). An already-set shell var wins over the file (Node's
 * `loadEnvFile` doesn't override), so exports still take precedence. Returns the file it
 * loaded, or null. No-op if none exist or the runtime lacks `process.loadEnvFile`.
 */
export function loadLocalEnv(cwd: string): string | null {
  const load = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof load !== "function") return null;
  const candidates = [
    join(cwd, ".vercel", ".env.production.local"),
    join(cwd, ".env.local"),
    join(cwd, ".env"),
  ];
  for (const f of candidates) {
    if (existsSync(f)) {
      try {
        load(f);
        return f;
      } catch (err) {
        // A malformed env file would otherwise silently leave doctor checking an
        // unloaded env — say which file failed and why, then fall through to the next
        // candidate (a bad .vercel/.env.production.local shouldn't block a valid .env).
        console.warn(`⚠ could not load env from ${f}: ${err instanceof Error ? err.message : String(err)} — trying the next candidate.`);
      }
    }
  }
  return null;
}

/**
 * Locate the authored connection file with the SAME precedence `deskmate sync` uses
 * (see sync/plan.ts): deskmate-local `roles/<role>/connections/<name>.ts` FIRST, then
 * shared `connections/<name>.ts`. Matching the order matters — when a role-local file
 * shadows a shared one of the same name, sync deploys the role-local file, so doctor
 * must probe that same file or it validates something the deploy never runs.
 */
export function findConnectionFile(name: string, cwd: string): string | null {
  const rolesDir = join(cwd, "roles");
  if (existsSync(rolesDir)) {
    // Sort for a deterministic pick when >1 role has a same-named connection file —
    // raw readdir order varies by filesystem/platform.
    for (const id of readdirSync(rolesDir).sort()) {
      const p = join(rolesDir, id, "connections", `${name}.ts`);
      if (existsSync(p)) return p;
    }
  }
  const shared = join(cwd, "connections", `${name}.ts`);
  if (existsSync(shared)) return shared;
  return null;
}

/** Import the authored file and resolve URL + outgoing headers as the runtime would. */
async function resolveConnectionReal(name: string, cwd: string): Promise<ResolvedConn> {
  const file = findConnectionFile(name, cwd);
  if (!file) return { kind: "not-found" };
  // A broken connection file (syntax error, a definition eve rejects at import) is
  // itself a misconfig doctor should surface — catch it so one bad file becomes a
  // reported failure for THIS connection, not an uncaught reject that aborts the run
  // (mirrors loadTeam's guarded import). Needs Node ≥23.6 type-stripping either way.
  let def: any;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: any };
    def = mod.default ?? {};
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  const url: string = typeof def.url === "string" ? def.url : "";
  const allow: string[] = Array.isArray(def.tools?.allow) ? def.tools.allow : [];

  const headers: Record<string, string> = {};
  if (def.headers && typeof def.headers === "object" && typeof def.headers !== "function") {
    for (const [k, v] of Object.entries(def.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (v && typeof (v as any).then === "function") headers[k] = String(await v);
      // function-valued headers need a session ctx — skip; the probe reports the gap.
    }
  }
  if (def.auth && typeof def.auth.getToken === "function") {
    try {
      const { token } = await def.auth.getToken();
      if (token) headers["Authorization"] = `Bearer ${token}`;
    } catch {
      // getToken that needs a runtime ctx (e.g. connect()) — leave unauthenticated.
    }
  }

  if (!url || url.includes("example.invalid")) return { kind: "unconfigured", url: url || "(none)" };
  return { kind: "ready", url, headers, allow };
}

const defaultDeps: DoctorDeps = {
  loadTeam: realLoadTeam,
  resolveConnection: resolveConnectionReal,
  probe: (url, headers) => probeMcp(url, headers),
  loadEnv: loadLocalEnv,
};

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ⚠ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

/**
 * `deskmate doctor` (alias `check`): validate every configured MCP connection against
 * its real server before deploy. Run after `vercel env pull` so the local env matches
 * production. Exit 1 if any token connection is broken (unreachable / auth fail /
 * an allowed tool the server doesn't expose). not-found / unconfigured / oauth are
 * warnings — a scaffolded-but-not-yet-wired connection is a normal state.
 */
export async function doctor(_args: string[] = [], cwd: string = process.cwd(), deps: DoctorDeps = defaultDeps): Promise<number> {
  // Load the pulled prod env BEFORE importing any connection file (their headers/tokens
  // read process.env at import/getToken time). Without this, doctor's own documented
  // `vercel env pull` → `deskmate doctor` flow would check an empty env and no-op.
  const envFile = deps.loadEnv(cwd);
  if (envFile) console.log(`Checking against env from ${envFile}`);

  const team = await deps.loadTeam(cwd);
  const names = Object.keys(team.connections);
  if (names.length === 0) {
    console.log("No connections configured.");
    return 0;
  }

  let failures = 0;
  for (const name of names) {
    const conn = team.connections[name]!;
    console.log(`\n${name}:`);

    if (conn.connect) {
      warn(`oauth (Vercel Connect: ${conn.connect}) — credential resolved at runtime; not checked here.`);
      continue;
    }

    // The env prefix for guidance messages. `env` is always set for token connections
    // the CLI writes; fall back to the mcp-add default derivation so a hand-authored
    // `{ kind:"mcp" }` with neither `env` nor `connect` never prints `undefined_MCP_URL`.
    const prefix = conn.env ?? name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

    // A thrown resolveConnection (e.g. a custom dep) must not abort the whole run.
    let resolved: ResolvedConn;
    try {
      resolved = await deps.resolveConnection(name, cwd);
    } catch (err) {
      bad(`could not read the connection file: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
      continue;
    }
    if (resolved.kind === "not-found") {
      warn(`no authored connection file — run \`deskmate mcp-add ${name}\`.`);
      continue;
    }
    if (resolved.kind === "error") {
      bad(`connection file failed to load: ${resolved.message}`);
      failures++;
      continue;
    }
    if (resolved.kind === "unconfigured") {
      warn(`not configured (${resolved.url}) — set ${prefix}_MCP_URL / ${prefix}_MCP_TOKEN.`);
      continue;
    }

    const r = await deps.probe(resolved.url, resolved.headers);
    if (!r.reachable) {
      bad(`unreachable: ${r.error ?? "no response"}`);
      failures++;
      continue;
    }
    if (!r.authOk) {
      bad(`auth failed${r.status ? ` (HTTP ${r.status})` : ""} — check ${prefix}_MCP_TOKEN.`);
      failures++;
      continue;
    }
    // Authed but tools/list errored or truncated (HTTP/parse/transport, or the page
    // cap) — the tool set is unreliable, so the allow-list diff below can't be trusted.
    // Fail rather than pass green on an unverified connection.
    if (r.error) {
      bad(`authed, but listing tools failed (${r.error}) — can't verify the allow-list.`);
      failures++;
      continue;
    }
    ok(`reachable + authed (${r.tools?.length ?? 0} tools on server)`);

    const missing = resolved.allow.filter((t) => !(r.tools ?? []).includes(t));
    if (resolved.allow.length === 0) {
      warn("no tools.allow set — the model sees every server tool.");
    } else if (missing.length) {
      bad(`allow-list names tools the server does not expose: ${missing.join(", ")}`);
      failures++;
    } else {
      ok(`all ${resolved.allow.length} allowed tool(s) exist on the server.`);
    }
  }

  console.log(failures ? `\n✗ ${failures} connection(s) need attention.` : "\n✓ all connections healthy.");
  return failures ? 1 : 0;
}
