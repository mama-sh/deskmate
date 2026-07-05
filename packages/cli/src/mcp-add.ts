import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { renderMcpConnection, renderConnectConnection } from "./lib/mcp-template.js";
import { appendConnectionEntry, renderEntry } from "./config-file.js";
import { CONFIG_FILE, editConfig } from "./add.js";
import { isValidId } from "./lib/ids.js";

/**
 * Run `fn` with an `ask(question, fallback)` helper. Buffers stdin lines so it
 * works for both interactive and piped (`printf … | …`) input, falling back to
 * each prompt's default when input runs out.
 */
async function withPrompts<T>(
  fn: (ask: (q: string, fallback?: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const buffered: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  const nextLine = (): Promise<string | null> => {
    if (buffered.length) return Promise.resolve(buffered.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const ask = async (q: string, fallback?: string) => {
    process.stdout.write(fallback ? `${q} [${fallback}]: ` : `${q}: `);
    const a = ((await nextLine()) ?? "").trim();
    return a || fallback || "";
  };
  try {
    return await fn(ask);
  } finally {
    rl.close();
  }
}

/**
 * Scaffold an app-scoped OAuth (Vercel Connect) MCP connection: write
 * `./connections/<name>.ts` and append a `{ kind:"mcp", connect, service }` entry
 * to `./deskmate.config.ts`. Never clobbers an existing connection file.
 */
export function scaffoldConnectConnection(
  spec: { name: string; connector: string; service: string; url: string; description: string; tools: string[] },
  cwd: string,
): void {
  const file = join(cwd, "connections", `${spec.name}.ts`);
  if (existsSync(file)) {
    console.log(`• ${spec.name}: connections/${spec.name}.ts already exists, skipping (edit it directly, or remove it first)`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderConnectConnection(spec));
  console.log(`✓ created connections/${spec.name}.ts`);

  const entry = { kind: "mcp", connect: spec.connector, service: spec.service || undefined };
  editConfig(
    cwd,
    spec.name,
    (s) => appendConnectionEntry(s, spec.name, entry),
    renderEntry(spec.name, entry),
    `${spec.name}: already in connections`,
  );
  console.log(`  provision it with \`deskmate connect ${spec.name}\`.`);
}

/**
 * `deskmate mcp-add <name>`: scaffold a read-only, env-token MCP connection into
 * the consumer-local `./connections/<name>.ts`, and append a `connections.<name>`
 * entry to `./deskmate.config.ts` (or print it if the config can't be edited).
 */
export async function mcpAdd(args: string[], cwd: string = process.cwd()): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("usage: deskmate mcp-add <name>");
  if (!isValidId(name)) {
    throw new Error("<name> must be a snake_case identifier (lowercase letter, then letters/digits/underscores).");
  }
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  await withPrompts(async (ask) => {
    const mode = (await ask("Auth [token/oauth]", "token")).toLowerCase();
    if (mode === "oauth") {
      const connector = await ask("Connector UID", `${name}/deskmate`);
      const url = await ask("MCP URL", `https://mcp.${name}.com`);
      let serviceDefault = "";
      try { serviceDefault = new URL(url).host; } catch { serviceDefault = ""; }
      const service = await ask("Connect service id", serviceDefault);
      const description = await ask("Description (for the model)", `${name} (OAuth MCP).`);
      const toolsRaw = await ask("Read tools (comma-separated)", "");
      const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);
      scaffoldConnectConnection({ name, connector, service, url, description, tools }, cwd);
      return;
    }
    // ── token path (unchanged) ─────────────────────────────────────────────
    const urlEnv = await ask("URL env var", `${upper}_MCP_URL`);
    const tokenEnv = await ask("Token env var", `${upper}_MCP_TOKEN`);
    const description = await ask("Description (for the model)", `Read-only ${name} MCP.`);
    const toolsRaw = await ask("Read tools (comma-separated)", "");
    const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);

    const file = join(cwd, "connections", `${name}.ts`);
    // Never clobber an existing connection — a consumer may have hand-edited its
    // auth/URL/tool-allow-list. Skip (and don't touch the config) if it's there.
    if (existsSync(file)) {
      console.log(
        `• ${name}: connections/${name}.ts already exists, skipping (edit it directly, or remove it first)`,
      );
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderMcpConnection({ name, urlEnv, tokenEnv, description, tools }));
    console.log(`✓ created connections/${name}.ts`);

    // The config connection entry: kind:"mcp" + the env prefix. The prefix is only
    // well-defined when the two env var names have the `<PREFIX>_MCP_URL` /
    // `<PREFIX>_MCP_TOKEN` shape and share one prefix; otherwise deriving it would
    // silently emit a wrong `env`, so skip the config entry and say so.
    const urlPrefix = urlEnv.endsWith("_MCP_URL") ? urlEnv.slice(0, -"_MCP_URL".length) : null;
    const tokenPrefix = tokenEnv.endsWith("_MCP_TOKEN") ? tokenEnv.slice(0, -"_MCP_TOKEN".length) : null;
    if (!urlPrefix || !tokenPrefix || urlPrefix !== tokenPrefix) {
      console.error(
        `✗ env var names must be <PREFIX>_MCP_URL + <PREFIX>_MCP_TOKEN sharing one prefix ` +
          `(got ${urlEnv} + ${tokenEnv}). Skipped the connections.${name} config entry — ` +
          `add it to ${CONFIG_FILE} by hand once the names line up.`,
      );
      process.exitCode = 1;
      return;
    }
    const entry = { kind: "mcp", env: urlPrefix };
    editConfig(
      cwd,
      name,
      (s) => appendConnectionEntry(s, name, entry),
      renderEntry(name, entry),
      `${name}: already in connections`,
    );
    console.log(`  set ${urlEnv} + ${tokenEnv} in your env, then run \`deskmate sync\`.`);
  });
}
