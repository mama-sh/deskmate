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
}

/** Locate the authored connection file: shared root, then any roles/<id>/connections/. */
function findConnectionFile(name: string, cwd: string): string | null {
  const shared = join(cwd, "connections", `${name}.ts`);
  if (existsSync(shared)) return shared;
  const rolesDir = join(cwd, "roles");
  if (existsSync(rolesDir)) {
    for (const id of readdirSync(rolesDir)) {
      const p = join(rolesDir, id, "connections", `${name}.ts`);
      if (existsSync(p)) return p;
    }
  }
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
