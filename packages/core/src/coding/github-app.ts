import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  org: string;
}

/**
 * Least-privilege scoping for a minted installation token. `permissions` down-scopes
 * to specific permissions (e.g. `{ contents: "read" }` for the sandbox clone token vs
 * `{ contents: "write", pull_requests: "write" }` for the runtime push token);
 * `repositoryNames` restricts the token to specific repos. Omit both for a token with
 * the App installation's full permissions.
 */
export interface InstallTokenScope {
  permissions?: Record<string, "read" | "write">;
  repositoryNames?: string[];
}

export interface GithubAppDeps {
  createAppAuth: typeof createAppAuth;
  /** Resolve the app's installation id for the org (an app/JWT-authed request). */
  listInstallationForOrg: (cfg: GithubAppConfig) => Promise<{ installationId: number }>;
}

const defaultDeps: GithubAppDeps = {
  createAppAuth,
  async listInstallationForOrg({ appId, privateKey, org }) {
    const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
    const { data } = await appOctokit.rest.apps.getOrgInstallation({ org });
    return { installationId: data.id };
  },
};

/**
 * Mint a short-lived GitHub App installation access token for `org`. Best-practice
 * auth for an autonomous coding agent: ~1h lifetime, fine-grained, per-org
 * revocation — never a long-lived PAT. The token is brokered at the sandbox
 * firewall (it never enters the sandbox) and used by the approval-gated push/PR
 * step. Injected `deps` keep this unit-testable without touching the network.
 */
export async function getInstallationToken(
  cfg: GithubAppConfig & InstallTokenScope,
  deps: GithubAppDeps = defaultDeps,
): Promise<string> {
  const { installationId } = await deps.listInstallationForOrg(cfg);
  const auth = deps.createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
  const result = await auth({
    type: "installation",
    installationId,
    permissions: cfg.permissions,
    repositoryNames: cfg.repositoryNames,
  });
  return result.token;
}

/**
 * Resolve GitHub App config from env. `GITHUB_APP_PRIVATE_KEY` commonly carries the
 * PEM with literal `\n` sequences (e.g. from `vercel env`), so un-escape them.
 * `present` is true only when both the app id and private key are set.
 */
export function readGithubAppEnv(
  env: Record<string, string | undefined> = process.env,
): GithubAppConfig & { present: boolean } {
  const appId = env.GITHUB_APP_ID ?? "";
  const privateKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const org = env.GITHUB_APP_ORG ?? "";
  return { appId, privateKey, org, present: Boolean(appId && privateKey) };
}
