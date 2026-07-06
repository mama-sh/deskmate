import { defaultBackend, defineSandbox } from "eve/sandbox";
import { getInstallationToken, readGithubAppEnv } from "./github-app.js";

export interface CodingSandboxOptions {
  /** The single GitHub org whose installation token is brokered for git. */
  org: string;
  /**
   * Test seam. Defaults to minting an installation token for `org` from the App
   * env, or `null` when the App isn't configured (local dev) — in which case there
   * is nothing to broker and egress is left at the backend default.
   */
  getToken?: () => Promise<string | null>;
}

/**
 * GitHub git-over-HTTPS with an App installation token uses Basic auth with the
 * username `x-access-token` and the token as the password — NOT `Bearer`. The
 * firewall injects this header on egress so the token never enters the sandbox.
 */
function basicInstallationAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/**
 * Build the eve sandbox for a coding deskmate. Egress is a deny-by-default
 * allowlist (git + the common package registries + the AI gateway); requests to
 * `github.com` are credential-brokered at the firewall with a short-lived
 * installation token. Extend `allow` if a repo's toolchain needs more hosts.
 *
 * Requires a firewall-capable backend (Vercel or microsandbox) for the broker to
 * apply; the local Docker backend honors only allow-all/deny-all, so pushing does
 * not work locally (documented — use the read-only/PAT fallback for local dev).
 */
export function createCodingSandbox(opts: CodingSandboxOptions) {
  const getToken =
    opts.getToken ??
    (async () => {
      const env = readGithubAppEnv();
      // No App creds (local dev): don't mint — there's nothing to broker, and
      // calling GitHub with empty creds would throw and crash onSession.
      if (!env.present) return null;
      // READ-ONLY token: the sandbox is the untrusted execution plane, so it only
      // gets clone/fetch access. Writes never happen here — the approval-gated
      // open_pull_request tool creates the commit + PR from the trusted runtime with
      // a separate write token (control-plane / execution-plane separation).
      return getInstallationToken({
        appId: env.appId,
        privateKey: env.privateKey,
        org: opts.org,
        permissions: { contents: "read", metadata: "read" },
      });
    });

  return defineSandbox({
    backend: defaultBackend({ vercel: { resources: { vcpus: 2 } } }),
    async onSession({ use }) {
      const token = await getToken();
      const sandbox = await use();
      if (!token) {
        // App not configured (local dev). Nothing to broker; leave egress at the
        // backend default. Cloning/pushing private repos needs the App + Vercel
        // backend (documented) — this keeps `deskmate dev` from crashing.
        return;
      }
      const brokered = [{ transform: [{ headers: { authorization: basicInstallationAuth(token) } }] }];
      const policy = {
        allow: {
          "github.com": brokered,
          "codeload.github.com": brokered,
          "*.githubusercontent.com": [],
          "registry.npmjs.org": [],
          "*.npmjs.org": [],
          "pypi.org": [],
          "files.pythonhosted.org": [],
          "ai-gateway.vercel.sh": [],
        },
      };
      // Applied before any model/tool code runs this turn. On a firewall-capable
      // backend (Vercel/microsandbox) this brokers the install token and locks egress.
      // Local Docker (allow-all/deny-all only) and just-bash can't apply it — that's an
      // expected local limitation (coding needs the Vercel backend), so don't crash
      // `deskmate dev`; on Vercel a failure here is real and rethrows.
      try {
        await sandbox.setNetworkPolicy(policy);
      } catch (err) {
        if (process.env.VERCEL) throw err;
        console.warn(
          "[deskmate coding] sandbox egress policy not applied on this backend " +
            "(local dev; cloning/pushing private repos needs the Vercel backend): " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    },
  });
}
