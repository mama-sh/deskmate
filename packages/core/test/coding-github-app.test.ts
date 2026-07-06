import { describe, it, expect, vi } from "vitest";
import { getInstallationToken, readGithubAppEnv } from "../src/coding/github-app.js";

describe("getInstallationToken", () => {
  it("resolves the org installation then mints an installation token", async () => {
    const authFn = vi.fn().mockResolvedValue({ token: "ghs_installtoken" });
    const createAppAuth = vi.fn().mockReturnValue(authFn);
    const listInstallationForOrg = vi.fn().mockResolvedValue({ installationId: 42 });

    const tok = await getInstallationToken(
      { appId: "1", privateKey: "pk", org: "acme" },
      { createAppAuth: createAppAuth as never, listInstallationForOrg },
    );

    expect(tok).toBe("ghs_installtoken");
    expect(listInstallationForOrg).toHaveBeenCalledWith({ appId: "1", privateKey: "pk", org: "acme" });
    expect(createAppAuth).toHaveBeenCalledWith({ appId: "1", privateKey: "pk" });
    expect(authFn).toHaveBeenCalledWith(expect.objectContaining({ type: "installation", installationId: 42 }));
  });
});

describe("readGithubAppEnv", () => {
  it("reads the GITHUB_APP_* env and un-escapes \\n in the private key", () => {
    const env = readGithubAppEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
      GITHUB_APP_ORG: "acme",
    });
    expect(env).toMatchObject({ appId: "123", org: "acme", present: true });
    expect(env.privateKey).toBe("-----BEGIN-----\nabc\n-----END-----");
  });

  it("present=false when the app id or private key is missing", () => {
    expect(readGithubAppEnv({}).present).toBe(false);
    expect(readGithubAppEnv({ GITHUB_APP_ID: "1" }).present).toBe(false);
    expect(readGithubAppEnv({ GITHUB_APP_PRIVATE_KEY: "k" }).present).toBe(false);
  });
});
