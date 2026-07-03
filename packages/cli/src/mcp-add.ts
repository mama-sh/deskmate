import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { renderMcpConnection } from "./lib/mcp-template.js";
import { appendConnectionEntry, renderEntry } from "./config-file.js";
import { editConfig } from "./add.js";

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
 * `deskmate mcp-add <name>`: scaffold a read-only, env-token MCP connection into
 * the consumer-local `./connections/<name>.ts`, and append a `connections.<name>`
 * entry to `./deskmate.config.ts` (or print it if the config can't be edited).
 */
export async function mcpAdd(args: string[], cwd: string = process.cwd()): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("usage: deskmate mcp-add <name>");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error("<name> must be a snake_case identifier (lowercase letter, then letters/digits/underscores).");
  }
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  await withPrompts(async (ask) => {
    const urlEnv = await ask("URL env var", `${upper}_MCP_URL`);
    const tokenEnv = await ask("Token env var", `${upper}_MCP_TOKEN`);
    const description = await ask("Description (for the model)", `Read-only ${name} MCP.`);
    const toolsRaw = await ask("Read tools (comma-separated)", "");
    const tools = toolsRaw.split(",").map((t) => t.trim()).filter(Boolean);

    const file = join(cwd, "connections", `${name}.ts`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderMcpConnection({ name, urlEnv, tokenEnv, description, tools }));
    console.log(`✓ created connections/${name}.ts`);

    // The config connection entry: kind:"mcp" + the env prefix (<PREFIX>_MCP_URL/_TOKEN).
    const env = urlEnv.replace(/_MCP_URL$/, "");
    const entry = { kind: "mcp", env };
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
