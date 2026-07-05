import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldConnectConnection } from "../src/mcp-add.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deskmate-mcpadd-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spec = {
  name: "vercel",
  connector: "vercel/deskmate",
  service: "mcp.vercel.com",
  url: "https://mcp.vercel.com",
  description: "Vercel (read-only).",
  tools: ["list_deployments"],
};

describe("scaffoldConnectConnection", () => {
  it("writes an app-scoped connect() connection file", () => {
    scaffoldConnectConnection(spec, dir);
    const file = join(dir, "connections", "vercel.ts");
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, "utf8");
    expect(src).toContain('import { connect } from "@vercel/connect/eve";');
    expect(src).toContain('auth: connect({ connector: "vercel/deskmate", principalType: "app" })');
  });

  it("appends a { kind:'mcp', connect, service } entry to deskmate.config.ts", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(
      cfg,
      `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`,
    );
    scaffoldConnectConnection(spec, dir);
    const src = readFileSync(cfg, "utf8");
    expect(src).toContain("vercel: {");
    expect(src).toContain('kind: "mcp"');
    expect(src).toContain('connect: "vercel/deskmate"');
    expect(src).toContain('service: "mcp.vercel.com"');
  });

  it("omits `service` from the config entry when it is empty", () => {
    const cfg = join(dir, "deskmate.config.ts");
    writeFileSync(
      cfg,
      `import { defineTeam } from "@deskmate/core";\nexport default defineTeam({\n  connections: {\n  },\n  deskmates: {},\n});\n`,
    );
    scaffoldConnectConnection({ ...spec, service: "" }, dir);
    const src = readFileSync(cfg, "utf8");
    expect(src).toContain('connect: "vercel/deskmate"');
    expect(src).not.toContain("service:");
  });

  it("never clobbers an existing connection file", () => {
    scaffoldConnectConnection(spec, dir); // creates connections/vercel.ts
    const file = join(dir, "connections", "vercel.ts");
    writeFileSync(file, "// hand-edited\n");
    scaffoldConnectConnection(spec, dir); // second call must skip
    expect(readFileSync(file, "utf8")).toBe("// hand-edited\n");
  });
});
