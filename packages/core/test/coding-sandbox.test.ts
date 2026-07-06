import { describe, it, expect } from "vitest";
import { createCodingSandbox, sandboxRepoScope } from "../src/coding/sandbox.js";

type Policy = { allow: Record<string, Array<{ transform: Array<{ headers: Record<string, string> }> }>> };

// Drive the sandbox definition's onSession with a fake `use` that returns a fake
// sandbox handle, capturing the network policy it applies via setNetworkPolicy.
async function capturePolicies(
  def: ReturnType<typeof createCodingSandbox>,
  opts: { throwOnPolicy?: boolean } = {},
) {
  const policies: Policy[] = [];
  const sandbox = {
    setNetworkPolicy: async (p: Policy) => {
      if (opts.throwOnPolicy) throw new Error("backend does not support fine-grained policy");
      policies.push(p);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (def as any).onSession({ use: async () => sandbox, ctx: {} });
  return policies;
}

describe("createCodingSandbox", () => {
  it("brokers the github install token as Basic x-access-token at the firewall", async () => {
    const def = createCodingSandbox({ org: "acme", repos: [], getToken: async () => "ghs_tok" });
    const [policy] = await capturePolicies(def);

    const authHeader = policy.allow["github.com"][0].transform[0].headers.authorization;
    expect(authHeader).toMatch(/^Basic /);
    expect(Buffer.from(authHeader.slice("Basic ".length), "base64").toString()).toBe("x-access-token:ghs_tok");
  });

  it("locks egress to a github + registries allowlist (no wildcard catch-all)", async () => {
    const def = createCodingSandbox({ org: "acme", repos: [], getToken: async () => "t" });
    const [policy] = await capturePolicies(def);
    expect(Object.keys(policy.allow)).toEqual(expect.arrayContaining(["github.com", "registry.npmjs.org"]));
    expect(policy.allow).not.toHaveProperty("*"); // deny-by-default, not a general egress hole
  });

  it("does not crash locally when the backend rejects the policy (no VERCEL env)", async () => {
    const prev = process.env.VERCEL;
    delete process.env.VERCEL;
    try {
      const def = createCodingSandbox({ org: "acme", repos: [], getToken: async () => "t" });
      await expect(capturePolicies(def, { throwOnPolicy: true })).resolves.toEqual([]);
    } finally {
      if (prev !== undefined) process.env.VERCEL = prev;
    }
  });

  it("skips brokering (applies no policy) when no install token is available (local dev)", async () => {
    const def = createCodingSandbox({ org: "acme", repos: [], getToken: async () => null });
    const policies = await capturePolicies(def);
    expect(policies).toEqual([]);
  });

  it("configures a backend", () => {
    const def = createCodingSandbox({ org: "acme", repos: [], getToken: async () => "t" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((def as any).backend).toBeDefined();
  });
});

describe("sandboxRepoScope", () => {
  it("scopes the read token to exact allowlisted repos", () => {
    expect(sandboxRepoScope(["acme/api", "acme/web"])).toEqual(["api", "web"]);
  });
  it("stays org-wide (undefined) for an owner glob or empty allowlist", () => {
    expect(sandboxRepoScope(["acme/*"])).toBeUndefined();
    expect(sandboxRepoScope([])).toBeUndefined();
    expect(sandboxRepoScope(["acme/api", "acme/*"])).toBeUndefined();
  });
});
