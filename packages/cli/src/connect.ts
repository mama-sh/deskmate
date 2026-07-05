import type { ConnectionConfig } from "@deskmate/core";
import { runCommand } from "./lib/run.js";
import { loadTeam, CONFIG_FILE } from "./lib/load-config.js";

/** Side effects `connectCommand` needs — injected so orchestration is unit-testable. */
export interface ConnectDeps {
  loadConnections: (cwd: string) => Promise<Record<string, ConnectionConfig>>;
  run: (cmd: string, args: string[], cwd: string) => Promise<number>;
}

const defaultDeps: ConnectDeps = {
  loadConnections: async (cwd) => (await loadTeam(cwd)).connections,
  run: runCommand,
};

/**
 * `deskmate connect <name> [service]`: provision the app-scoped Vercel Connect
 * connector for an oauth MCP connection declared in `deskmate.config.ts`:
 *
 *   vercel connect create <service> --name <connector-name>
 *   vercel connect attach <connector-uid> --yes
 *   vercel env pull
 *
 * `service` comes from the connection's `service` field (written by
 * `deskmate mcp-add`) or an explicit positional arg. The connector name is the
 * UID's suffix (after the last `/`). Requires the Vercel CLI installed and
 * authenticated (`vercel login`). Safe to re-run: a `create` that fails because
 * the connector already exists is tolerated; real problems surface at `attach`.
 */
export async function connectCommand(
  args: string[] = [],
  cwd: string = process.cwd(),
  deps: ConnectDeps = defaultDeps,
): Promise<number> {
  const name = args[0];
  if (!name) {
    console.error("usage: deskmate connect <name> [service]");
    return 1;
  }
  const connections = await deps.loadConnections(cwd);
  const conn = connections[name];
  if (!conn) {
    console.error(`✗ no connection "${name}" in ${CONFIG_FILE}. Run \`deskmate mcp-add ${name}\` first.`);
    return 1;
  }
  if (!conn.connect) {
    console.error(`✗ connection "${name}" isn't an oauth (connect) connection — nothing to provision.`);
    return 1;
  }
  const uid = conn.connect;
  const service = args[1] ?? conn.service;
  if (!service) {
    console.error(
      `✗ no Connect service for "${name}". Add a \`service\` to the connection in ${CONFIG_FILE}, ` +
        `or pass it: \`deskmate connect ${name} <service>\`.`,
    );
    return 1;
  }
  const connectorName = uid.includes("/") ? uid.slice(uid.lastIndexOf("/") + 1) : uid;

  const createCode = await deps.run("vercel", ["connect", "create", service, "--name", connectorName], cwd);
  if (createCode !== 0) {
    console.log(`  (vercel connect create exited ${createCode} — continuing; the connector may already exist)`);
  }
  const attachCode = await deps.run("vercel", ["connect", "attach", uid, "--yes"], cwd);
  if (attachCode !== 0) {
    console.error(
      `✗ vercel connect attach failed (${attachCode}). The connector UID must be \`<service>/<name>\` as minted ` +
        `by \`vercel connect create\`. If it differs, update BOTH \`connect:\` for "${name}" in ${CONFIG_FILE} ` +
        `and the \`connector:\` literal in connections/${name}.ts to the UID \`vercel connect create\` printed, then re-run.`,
    );
    return attachCode;
  }
  return deps.run("vercel", ["env", "pull"], cwd);
}
