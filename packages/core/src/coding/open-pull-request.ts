import { Octokit } from "@octokit/rest";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getInstallationToken, readGithubAppEnv } from "./github-app.js";

export interface SubmitInput {
  repo: string; // "owner/name"
  branch: string; // deskmate/<id>/<slug>
  base: string; // base branch (repo default)
  title: string;
  body: string;
  allowlist: string[]; // owner/name globs the deskmate may touch
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SubmitDeps {
  /** Run a git command in the sandbox working tree; returns stdout/stderr/exitCode. */
  runGit: (command: string) => Promise<GitResult>;
  /** Open a PR via the GitHub API (installation-token auth), returns its url. */
  openPr: (a: { repo: string; head: string; base: string; title: string; body: string }) => Promise<{ url: string }>;
}

// A pushable feature branch: the deskmate/<id>/<slug> convention, safe chars only
// (used verbatim in a shell `git push`, so this doubles as an injection guard).
const SAFE_FEATURE_BRANCH = /^deskmate\/[A-Za-z0-9._/-]+$/;
// owner/name, safe chars only, exactly two segments (rejects path traversal like
// "acme/api/../evil" and any shell metacharacters, defense-in-depth).
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** owner/name glob match: "acme/*" (any repo in owner) or "acme/api" (exact). */
function repoAllowed(repo: string, allowlist: string[]): boolean {
  const [rOwner, rName] = repo.split("/");
  if (!rOwner || !rName) return false;
  return allowlist.some((glob) => {
    const [gOwner, gName] = glob.split("/");
    if (!gOwner || !gName) return false;
    return gOwner === rOwner && (gName === "*" || gName === rName);
  });
}

/** Extract owner/name from a github remote url (https or ssh form), else null. */
export function parseGithubRepo(url: string): string | null {
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The single outbound, human-approved step: push an already-committed feature
 * branch and open a PR. Guards enforce the safety contract — never the default
 * branch, only a shell-safe deskmate/<id>/<slug> branch, only allowlisted repos,
 * and the push destination must be the approved repo (the sandbox `origin` is
 * verified to match `input.repo`, so the human approving the call controls where
 * the push actually lands). NEVER merges. Pure over injected `deps`.
 */
export async function submitPullRequest(input: SubmitInput, deps: SubmitDeps): Promise<{ url: string }> {
  if (input.branch === input.base) {
    throw new Error(`refusing to push to the base branch "${input.base}" — commit to a feature branch and open a PR`);
  }
  if (!SAFE_FEATURE_BRANCH.test(input.branch)) {
    throw new Error(`branch "${input.branch}" must be a deskmate/<id>/<slug> feature branch (letters, digits, . _ / -)`);
  }
  if (!SAFE_REPO.test(input.repo)) {
    throw new Error(`repo "${input.repo}" must be a plain "owner/name" (letters, digits, . _ -)`);
  }
  if (!repoAllowed(input.repo, input.allowlist)) {
    throw new Error(`repo "${input.repo}" is not in the coding allowlist (${input.allowlist.join(", ") || "none"})`);
  }
  // Bind the push to the approved repo: `git push origin` lands on whatever the
  // sandbox `origin` points at (set by the model's clone), so verify it IS the
  // approved repo before pushing — otherwise a model could clone repo A, approve a
  // call naming repo B, and push to A. This closes that confused-deputy gap.
  const originRes = await deps.runGit("git remote get-url origin");
  if (originRes.exitCode !== 0) {
    throw new Error(`could not read the sandbox git remote 'origin' (${originRes.stderr.trim() || `exit ${originRes.exitCode}`})`);
  }
  const originRepo = parseGithubRepo(originRes.stdout);
  if (!originRepo || originRepo.toLowerCase() !== input.repo.toLowerCase()) {
    throw new Error(
      `sandbox origin (${originRepo ?? (originRes.stdout.trim() || "unknown")}) does not match the approved repo ` +
        `"${input.repo}" — refusing to push`,
    );
  }
  const pushRes = await deps.runGit(`git push -u origin ${input.branch}`);
  if (pushRes.exitCode !== 0) {
    throw new Error(`git push failed: ${pushRes.stderr.trim() || `exit ${pushRes.exitCode}`}`);
  }
  const pr = await deps.openPr({
    repo: input.repo,
    head: input.branch,
    base: input.base,
    title: input.title,
    body: input.body,
  });
  return { url: pr.url };
}

export interface OpenPullRequestToolOptions {
  deskmateId: string;
  org: string;
  repos: string[];
}

/**
 * The approval-gated `open_pull_request` tool bound to a deskmate. `approval:
 * always()` pauses the call for human sign-off before anything leaves the sandbox
 * (the analysis/execution split). Reads/edits happen in-sandbox with no gate; only
 * this push+PR step is gated. Never merges.
 */
export function createOpenPullRequestTool(opts: OpenPullRequestToolOptions) {
  const allowlist = opts.repos.length ? opts.repos : [`${opts.org}/*`];
  return defineTool({
    description:
      "Push the committed deskmate/<id>/<slug> feature branch and open a pull request for " +
      "human review. NEVER targets the default branch and NEVER merges. Requires approval " +
      "before it runs. Commit your change on the feature branch first, then call this.",
    inputSchema: z.object({
      repo: z.string().describe('the "owner/name" of the repo cloned into the sandbox'),
      branch: z.string().describe("the deskmate/<id>/<slug> feature branch you committed to"),
      base: z.string().default("main").describe("the base branch to open the PR against (usually the repo default)"),
      title: z.string().describe("PR title"),
      body: z.string().describe("PR description: what changed, why, and how you verified it"),
    }),
    approval: always(),
    async execute(input, ctx) {
      const sandbox = await ctx.getSandbox();
      const deps: SubmitDeps = {
        runGit: async (command) => {
          const r = await sandbox.run({ command });
          return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
        },
        openPr: async (a) => {
          const env = readGithubAppEnv();
          const token = await getInstallationToken({ appId: env.appId, privateKey: env.privateKey, org: opts.org });
          const octokit = new Octokit({ auth: token });
          const [owner, repo] = a.repo.split("/");
          const { data } = await octokit.rest.pulls.create({
            owner,
            repo,
            head: a.head,
            base: a.base,
            title: a.title,
            body: a.body,
          });
          return { url: data.html_url };
        },
      };
      return submitPullRequest({ ...input, allowlist }, deps);
    },
  });
}
