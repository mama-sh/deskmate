#!/usr/bin/env node
import { add } from "./add.js";
import { remove } from "./remove.js";
import { list } from "./list.js";
import { mcpAdd } from "./mcp-add.js";
import { syncCommand } from "./sync/index.js";
import { dev } from "./dev.js";

const USAGE = [
  "usage:",
  "  deskmate add <id...>      copy catalog role(s) into ./roles + add config entries",
  "  deskmate remove <id...>   delete ./roles/<id> + drop its config entry",
  "  deskmate list             list the catalog roles",
  "  deskmate mcp-add <name>   scaffold a read-only MCP connection into ./connections",
  "  deskmate sync             regenerate the agent/** tree from deskmate.config.ts",
  "  deskmate dev              sync + eve dev with live re-sync on config edits",
].join("\n");

const [command, ...rest] = process.argv.slice(2);

// Top-level guard: print just the message (not a stack trace) and exit non-zero
// on a usage error or a command failure — standard CLI behavior.
try {
  switch (command) {
    case "add":
      if (rest.length === 0) throw new Error("usage: deskmate add <id...>");
      add(rest);
      break;
    case "remove":
      if (rest.length === 0) throw new Error("usage: deskmate remove <id...>");
      remove(rest);
      break;
    case "list":
      list();
      break;
    case "mcp-add":
      await mcpAdd(rest);
      break;
    case "sync":
      await syncCommand();
      break;
    case "dev":
      process.exitCode = await dev(rest);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
