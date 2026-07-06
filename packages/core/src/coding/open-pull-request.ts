import { Octokit } from "@octokit/rest";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { getInstallationToken, readGithubAppEnv } from "./github-app.js";

export interface SubmitInput {
  repo: string; // "owner/name"
  branch: string; // deskmate/<deskmateId>/<slug>
  base?: string; // base branch; defaults to the repo's default branch
  title: string;
  body: string;
  commitMessage: string;
  deskmateId: string; // set from the tool binding, NOT model input — namespaces the branch
  allowlist: string[]; // owner/name globs the deskmate may touch
}

/** One file change to include in the API commit. `content: null` means delete. */
export interface ChangedFile {
  path: string;
  content: string | null;
  encoding: "utf-8" | "base64";
  mode: "100644" | "100755";
}

export interface SubmitDeps {
  /** The "owner/name" the sandbox has checked out (its `origin`), or null. */
  getOriginRepo: () => Promise<string | null>;
  /** The repo's default branch (used as the PR base when none is given). */
  getDefaultBranch: (repo: string) => Promise<string>;
  /** The net changed files on the sandbox's HEAD vs `base` (read-only). */
  readChangedFiles: (base: string) => Promise<ChangedFile[]>;
  /** Create the branch + commit from the changes, via the GitHub API (write token). */
  pushCommit: (a: { repo: string; base: string; branch: string; message: string; files: ChangedFile[] }) => Promise<void>;
  /** Open the PR (write token), returns its url. */
  openPr: (a: { repo: string; head: string; base: string; title: string; body: string }) => Promise<{ url: string }>;
}

// A pushable feature branch: the deskmate/<id>/<slug> convention, safe chars only.
const SAFE_FEATURE_BRANCH = /^deskmate\/[A-Za-z0-9._/-]+$/;
// owner/name, safe chars, exactly two segments.
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// A safe git ref name (used in a shell `git diff` command — injection guard).
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;

/** Extract owner/name from a github remote url (https or ssh form), else null. */
export function parseGithubRepo(url: string): string | null {
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

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

/**
 * The single outbound, human-approved step. Guards enforce the safety contract
 * (only a deskmate/<id>/<slug> branch, never the base branch, only allowlisted
 * repos), then the change is committed to a new branch and a PR is opened —
 * entirely via the GitHub API from the trusted runtime. The write token NEVER
 * enters the sandbox (the sandbox holds only a read-only clone token), so a
 * misbehaving model cannot push outside this approved path. NEVER merges. Pure
 * over injected `deps`.
 */
export async function submitPullRequest(input: SubmitInput, deps: SubmitDeps): Promise<{ url: string }> {
  if (!SAFE_FEATURE_BRANCH.test(input.branch)) {
    throw new Error(`branch "${input.branch}" must be a deskmate/<id>/<slug> feature branch (letters, digits, . _ / -)`);
  }
  // Confine each deskmate to its OWN namespace, so deskmates sharing a repo can't
  // push (and force-update) each other's branches.
  if (!input.branch.startsWith(`deskmate/${input.deskmateId}/`)) {
    throw new Error(`branch "${input.branch}" must be in this deskmate's namespace: deskmate/${input.deskmateId}/<slug>`);
  }
  if (!SAFE_REPO.test(input.repo)) {
    throw new Error(`repo "${input.repo}" must be a plain "owner/name" (letters, digits, . _ -)`);
  }
  if (!repoAllowed(input.repo, input.allowlist)) {
    throw new Error(`repo "${input.repo}" is not in the coding allowlist (${input.allowlist.join(", ") || "none"})`);
  }
  // The diff is read from whatever the sandbox has checked out and committed to
  // input.repo — so verify the sandbox `origin` IS the approved repo, or a repo-A
  // checkout could be applied to repo B (cross-repo leak) despite the allowlist.
  const originRepo = await deps.getOriginRepo();
  if (!originRepo || originRepo.toLowerCase() !== input.repo.toLowerCase()) {
    throw new Error(
      `the sandbox has "${originRepo ?? "no origin"}" checked out, but the approved repo is ` +
        `"${input.repo}" — refusing to apply a diff across repos`,
    );
  }
  const base = input.base ?? (await deps.getDefaultBranch(input.repo));
  // `base` is interpolated into a shell `git diff` (readChangedFiles), so it must be a
  // safe ref name — a model-supplied base like `main"; rm -rf ~` would otherwise inject.
  if (!SAFE_REF.test(base)) {
    throw new Error(`base "${base}" is not a valid branch name (letters, digits, . _ / -)`);
  }
  if (input.branch === base) {
    throw new Error(`refusing to use the base branch "${base}" as the head — commit to a feature branch and open a PR`);
  }
  const files = await deps.readChangedFiles(base);
  if (files.length === 0) {
    throw new Error("no changes to submit — commit your work on the feature branch first");
  }
  await deps.pushCommit({ repo: input.repo, base, branch: input.branch, message: input.commitMessage, files });
  const pr = await deps.openPr({
    repo: input.repo,
    head: input.branch,
    base,
    title: input.title,
    body: input.body,
  });
  return { url: pr.url };
}

/** Minimal sandbox surface `readSandboxChanges` needs (subset of eve's SandboxSession). */
export interface SandboxLike {
  run: (opts: { command: string }) => Promise<{ stdout: string; exitCode: number }>;
  readBinaryFile: (opts: { path: string }) => Promise<Uint8Array>;
}

/**
 * Read the net changed files on the sandbox's HEAD vs `base`, WITHOUT running any
 * write git command. Uses `git diff --name-status -z` (NUL-delimited so odd paths
 * are safe) and reads each file's bytes via `readBinaryFile` (no shell, no path
 * interpolation). Content is base64 (works for text + binary); mode defaults to
 * 100644 (executable-bit preservation is a known limitation).
 */
export async function readSandboxChanges(sandbox: SandboxLike, base: string): Promise<ChangedFile[]> {
  const res = await sandbox.run({ command: `git diff --name-status -z "origin/${base}...HEAD"` });
  if (res.exitCode !== 0) {
    throw new Error(`could not diff against origin/${base} in the sandbox (exit ${res.exitCode})`);
  }
  const parts = res.stdout.split("\0").filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      // rename/copy: <old> <new> — treat as delete-old (rename only) + add-new
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (status.startsWith("R")) files.push({ path: oldPath, content: null, encoding: "utf-8", mode: "100644" });
      files.push(await readFileEntry(sandbox, newPath));
    } else {
      const path = parts[i++];
      if (status.startsWith("D")) files.push({ path, content: null, encoding: "utf-8", mode: "100644" });
      else files.push(await readFileEntry(sandbox, path)); // A, M, T
    }
  }
  return files;
}

async function readFileEntry(sandbox: SandboxLike, path: string): Promise<ChangedFile> {
  const bytes = await sandbox.readBinaryFile({ path });
  return { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64", mode: "100644" };
}

/** The "owner/name" the sandbox has checked out (its `origin` remote), or null. */
export async function readSandboxOrigin(sandbox: SandboxLike): Promise<string | null> {
  const res = await sandbox.run({ command: "git remote get-url origin" });
  if (res.exitCode !== 0) return null;
  return parseGithubRepo(res.stdout);
}

interface TreeEntry {
  path: string;
  mode: "100644" | "100755";
  type: "blob";
  sha: string | null; // null = delete
}

/** The narrow set of GitHub write operations `commitViaApi` needs (adapts Octokit). */
export interface RepoWriteApi {
  getRefSha: (ref: string) => Promise<string>;
  getCommitTreeSha: (commitSha: string) => Promise<string>;
  createBlob: (content: string, encoding: "utf-8" | "base64") => Promise<string>;
  createTree: (baseTreeSha: string, entries: TreeEntry[]) => Promise<string>;
  createCommit: (message: string, treeSha: string, parents: string[]) => Promise<string>;
  /** Create the branch ref; MUST reject (not overwrite) if it already exists. */
  createBranchRef: (branch: string, sha: string) => Promise<void>;
}

/**
 * Create a single commit containing `files` on top of `base`, and point `branch`
 * at it — all through the GitHub Git Data API (runs in the trusted runtime with a
 * write token). No git push, no write credential in the sandbox.
 */
export async function commitViaApi(
  api: RepoWriteApi,
  a: { base: string; branch: string; message: string; files: ChangedFile[] },
): Promise<void> {
  const baseSha = await api.getRefSha(`heads/${a.base}`);
  const baseTreeSha = await api.getCommitTreeSha(baseSha);
  const entries: TreeEntry[] = [];
  for (const f of a.files) {
    if (f.content === null) {
      entries.push({ path: f.path, mode: f.mode, type: "blob", sha: null });
    } else {
      const sha = await api.createBlob(f.content, f.encoding);
      entries.push({ path: f.path, mode: f.mode, type: "blob", sha });
    }
  }
  const treeSha = await api.createTree(baseTreeSha, entries);
  const commitSha = await api.createCommit(a.message, treeSha, [baseSha]);
  await api.createBranchRef(a.branch, commitSha);
}

function makeRepoWriteApi(octo: Octokit, owner: string, repo: string): RepoWriteApi {
  return {
    getRefSha: async (ref) => (await octo.rest.git.getRef({ owner, repo, ref })).data.object.sha,
    getCommitTreeSha: async (sha) => (await octo.rest.git.getCommit({ owner, repo, commit_sha: sha })).data.tree.sha,
    createBlob: async (content, encoding) => (await octo.rest.git.createBlob({ owner, repo, content, encoding })).data.sha,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createTree: async (baseTree, entries) => (await octo.rest.git.createTree({ owner, repo, base_tree: baseTree, tree: entries as any })).data.sha,
    createCommit: async (message, tree, parents) =>
      (await octo.rest.git.createCommit({ owner, repo, message, tree, parents })).data.sha,
    createBranchRef: async (branch, sha) => {
      try {
        await octo.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
      } catch (err) {
        // Never force-overwrite an existing branch (would silently clobber prior work,
        // including a human's commits). Fail clearly and let the deskmate use a new slug.
        if ((err as { status?: number }).status === 422) {
          throw new Error(
            `branch "${branch}" already exists on ${owner}/${repo} — use a new deskmate/<id>/<slug> ` +
              `(never overwriting an existing branch).`,
          );
        }
        throw err;
      }
    },
  };
}

export interface OpenPullRequestToolOptions {
  deskmateId: string;
  org: string;
  repos: string[];
}

/**
 * The approval-gated `open_pull_request` tool bound to a deskmate. `approval:
 * always()` pauses for human sign-off. The change is read from the (read-only)
 * sandbox and committed + PR'd from the runtime with a write token scoped to the
 * target repo — the write credential never enters the sandbox. Never merges.
 */
export function createOpenPullRequestTool(opts: OpenPullRequestToolOptions) {
  const allowlist = opts.repos.length ? opts.repos : [`${opts.org}/*`];
  return defineTool({
    description:
      "Commit the change on your deskmate/<id>/<slug> feature branch and open a pull request " +
      "for human review. NEVER targets the default branch and NEVER merges. Requires approval. " +
      "Commit your work on the feature branch first; this reads that diff and opens the PR.",
    inputSchema: z.object({
      repo: z.string().describe('the "owner/name" of the repo cloned into the sandbox'),
      branch: z.string().describe("the deskmate/<id>/<slug> feature branch you committed to"),
      base: z.string().optional().describe("base branch for the PR; defaults to the repo's default branch"),
      title: z.string().describe("PR title"),
      body: z.string().describe("PR description: what changed, why, and how you verified it"),
      commitMessage: z.string().describe("the commit message for the change"),
    }),
    approval: always(),
    async execute(input, ctx) {
      const sandbox = (await ctx.getSandbox()) as unknown as SandboxLike;
      const env = readGithubAppEnv();
      let octokitP: Promise<Octokit> | null = null;
      const octokitFor = (repoName: string) =>
        (octokitP ??= (async () => {
          if (!env.present) {
            throw new Error("GitHub App not configured — set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.");
          }
          const token = await getInstallationToken({
            appId: env.appId,
            privateKey: env.privateKey,
            org: opts.org,
            permissions: { contents: "write", pull_requests: "write" },
            repositoryNames: [repoName],
          });
          return new Octokit({ auth: token });
        })());
      const deps: SubmitDeps = {
        getOriginRepo: () => readSandboxOrigin(sandbox),
        getDefaultBranch: async (repo) => {
          const [owner, name] = repo.split("/");
          const octo = await octokitFor(name);
          return (await octo.rest.repos.get({ owner, repo: name })).data.default_branch;
        },
        readChangedFiles: (base) => readSandboxChanges(sandbox, base),
        pushCommit: async (a) => {
          const [owner, name] = a.repo.split("/");
          const octo = await octokitFor(name);
          await commitViaApi(makeRepoWriteApi(octo, owner, name), a);
        },
        openPr: async (a) => {
          const [owner, name] = a.repo.split("/");
          const octo = await octokitFor(name);
          const { data } = await octo.rest.pulls.create({
            owner,
            repo: name,
            head: a.head,
            base: a.base,
            title: a.title,
            body: a.body,
          });
          return { url: data.html_url };
        },
      };
      return submitPullRequest({ ...input, deskmateId: opts.deskmateId, allowlist }, deps);
    },
  });
}
