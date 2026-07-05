import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, loadLocalEnv, findConnectionFile, type DoctorDeps } from "../src/doctor.js";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

const team = (connections: Record<string, any>) => ({ connections, deskmates: {}, channels: {} }) as any;

function deps(over: Partial<DoctorDeps>): DoctorDeps {
  return {
    loadTeam: async () => team({}),
    resolveConnection: async () => ({ kind: "not-found" }),
    probe: async () => ({ reachable: true, authOk: true, tools: [] }),
    loadEnv: () => null, // hermetic: never touch the real filesystem env in unit tests
    ...over,
  };
}

describe("doctor", () => {
  it("exits 0 when a token connection is reachable, authed, and allow-list matches", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: { Authorization: "Bearer t" }, allow: ["search"] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["search", "extra"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(0);
  });

  it("exits 1 when an allowed tool does not exist on the server", async () => {
    const d = deps({
      loadTeam: async () => team({ w: { kind: "mcp", env: "W" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://w/mcp", headers: {}, allow: ["missing_tool"] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["real_tool"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 on an auth failure", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: true, authOk: false, status: 401 }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 when unreachable", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: false, authOk: false, error: "ECONNREFUSED" }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 when authed but tools/list errored — even with an empty allow-list (tools unverifiable)", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" } }),
      resolveConnection: async () => ({ kind: "ready", url: "https://good/mcp", headers: {}, allow: [] }),
      probe: async () => ({ reachable: true, authOk: true, tools: [], error: "tools/list HTTP 500" }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("treats unconfigured / not-found / oauth as warnings (exit 0)", async () => {
    const d = deps({
      loadTeam: async () => team({
        blank: { kind: "mcp", env: "BLANK" },
        missing: { kind: "mcp", env: "MISSING" },
        oauthy: { kind: "mcp", connect: "svc/deskmate" },
      }),
      resolveConnection: async (name) =>
        name === "blank" ? { kind: "unconfigured", url: "https://example.invalid/mcp" } : { kind: "not-found" },
    });
    expect(await doctor([], "/proj", d)).toBe(0);
  });

  it("exits 0 when there are no connections", async () => {
    expect(await doctor([], "/proj", deps({ loadTeam: async () => team({}) }))).toBe(0);
  });

  it("exits 1 with a healthy connection alongside a broken one (order-independent)", async () => {
    const d = deps({
      loadTeam: async () => team({ good: { kind: "mcp", env: "GOOD" }, bad: { kind: "mcp", env: "BAD" } }),
      resolveConnection: async (name) => ({ kind: "ready", url: `https://${name}/mcp`, headers: {}, allow: name === "bad" ? ["missing"] : [] }),
      probe: async () => ({ reachable: true, authOk: true, tools: ["real"] }),
    });
    expect(await doctor([], "/proj", d)).toBe(1);
  });

  it("exits 1 (and keeps going) when a connection file fails to load", async () => {
    let checked = 0;
    const d = deps({
      loadTeam: async () => team({ broken: { kind: "mcp", env: "BROKEN" }, ok2: { kind: "mcp", env: "OK2" } }),
      resolveConnection: async (name) => {
        checked++;
        return name === "broken" ? { kind: "error", message: "SyntaxError: bad" } : { kind: "ready", url: "https://ok2/mcp", headers: {}, allow: [] };
      },
    });
    expect(await doctor([], "/proj", d)).toBe(1);
    expect(checked).toBe(2); // the broken file did NOT abort the run — ok2 was still checked
  });

  it("exits 1 (never rejects) when resolveConnection itself throws", async () => {
    const d = deps({
      loadTeam: async () => team({ boom: { kind: "mcp", env: "BOOM" } }),
      resolveConnection: async () => { throw new Error("import blew up"); },
    });
    await expect(doctor([], "/proj", d)).resolves.toBe(1);
  });
});

describe("loadLocalEnv", () => {
  it("loads .vercel/.env.production.local into process.env (only vars not already set)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      mkdirSync(join(dir, ".vercel"), { recursive: true });
      writeFileSync(join(dir, ".vercel", ".env.production.local"), "DESKMATE_DOCTOR_TEST_URL=https://real/mcp\n");
      expect(process.env.DESKMATE_DOCTOR_TEST_URL).toBeUndefined();
      const loaded = loadLocalEnv(dir);
      expect(loaded).toBe(join(dir, ".vercel", ".env.production.local"));
      expect(process.env.DESKMATE_DOCTOR_TEST_URL).toBe("https://real/mcp");
    } finally {
      delete process.env.DESKMATE_DOCTOR_TEST_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no env file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      expect(loadLocalEnv(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns and returns null when an env file can't be loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-env-"));
    try {
      mkdirSync(join(dir, ".env")); // a directory named .env makes loadEnvFile throw (EISDIR)
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(loadLocalEnv(dir)).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findConnectionFile", () => {
  it("prefers a role-local connection file over a shared one (matches sync precedence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-conn-"));
    try {
      mkdirSync(join(dir, "connections"), { recursive: true });
      writeFileSync(join(dir, "connections", "foo.ts"), "// shared");
      mkdirSync(join(dir, "roles", "x", "connections"), { recursive: true });
      writeFileSync(join(dir, "roles", "x", "connections", "foo.ts"), "// role-local");
      expect(findConnectionFile("foo", dir)).toBe(join(dir, "roles", "x", "connections", "foo.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the shared file when no role-local exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "deskmate-conn-"));
    try {
      mkdirSync(join(dir, "connections"), { recursive: true });
      writeFileSync(join(dir, "connections", "foo.ts"), "// shared");
      expect(findConnectionFile("foo", dir)).toBe(join(dir, "connections", "foo.ts"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
