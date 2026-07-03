#!/usr/bin/env node
import { add } from "./add.js";
import { remove } from "./remove.js";
import { list } from "./list.js";
import { mcpAdd } from "./mcp-add.js";

const USAGE = [
  "usage:",
  "  deskmate add <id...>      copy catalog role(s) into ./roles + add config entries",
  "  deskmate remove <id...>   delete ./roles/<id> + drop its config entry",
  "  deskmate list             list the catalog roles",
  "  deskmate mcp-add <name>   scaffold a read-only MCP connection into ./connections",
  "  deskmate sync             regenerate the agent/** tree from deskmate.config.ts",
].join("\n");

const [command, ...rest] = process.argv.slice(2);

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
    console.log("deskmate sync: not implemented yet — Task 6.");
    break;
  default:
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
}
