import { describe, it, expect, vi } from "vitest";
import { submitPullRequest, parseGithubRepo } from "../src/coding/open-pull-request.js";

const base = {
  repo: "acme/api",
  branch: "deskmate/engineer/fix-typo",
  base: "main",
  title: "Fix typo",
  body: "why + how tested",
  allowlist: ["acme/*"],
};

// runGit resolves the origin lookup to the approved repo and succeeds on push.
function okDeps(overrides: { originUrl?: string; pushExit?: number } = {}) {
  const originUrl = overrides.originUrl ?? "https://github.com/acme/api.git\n";
  const pushExit = overrides.pushExit ?? 0;
  return {
    runGit: vi.fn(async (cmd: string) => {
      if (cmd.includes("remote get-url")) return { stdout: originUrl, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: pushExit ? "rejected" : "", exitCode: pushExit };
    }),
    openPr: vi.fn().mockResolvedValue({ url: "https://github.com/acme/api/pull/7" }),
  };
}

describe("submitPullRequest guards", () => {
  it("refuses to push to the base/default branch", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "main" }, deps)).rejects.toThrow(/base branch|default/i);
    expect(deps.runGit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("refuses a branch that isn't a deskmate/<id>/<slug> feature branch", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "hotfix" }, deps)).rejects.toThrow(/deskmate\//i);
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("refuses a branch with shell metacharacters (injection guard)", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "deskmate/e/x;rm -rf ~" }, deps)).rejects.toThrow();
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("refuses a branch with an embedded newline (the classic bypass vector)", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "deskmate/e/x\nmalicious" }, deps)).rejects.toThrow(/deskmate\//i);
    await expect(submitPullRequest({ ...base, branch: "deskmate/e/x\n" }, deps)).rejects.toThrow();
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("refuses a repo that isn't a plain owner/name (path traversal / metachars)", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, repo: "acme/api/../evil" }, deps)).rejects.toThrow(/owner\/name/i);
    await expect(submitPullRequest({ ...base, repo: "acme/api;rm" }, deps)).rejects.toThrow(/owner\/name/i);
    expect(deps.runGit).not.toHaveBeenCalled();
  });

  it("refuses a repo outside the allowlist", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, repo: "evil/x" }, deps)).rejects.toThrow(/allowlist/i);
    expect(deps.runGit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("refuses to push when the sandbox origin is a DIFFERENT repo than approved", async () => {
    const deps = okDeps({ originUrl: "https://github.com/acme/other.git" });
    await expect(submitPullRequest(base, deps)).rejects.toThrow(/does not match the approved repo/i);
    // it read origin, but never pushed and never opened a PR
    expect(deps.runGit).toHaveBeenCalledTimes(1);
    expect(deps.runGit).toHaveBeenCalledWith("git remote get-url origin");
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("surfaces a failed push and does NOT open a PR", async () => {
    const deps = okDeps({ pushExit: 1 });
    await expect(submitPullRequest(base, deps)).rejects.toThrow(/push failed/i);
    expect(deps.openPr).not.toHaveBeenCalled();
  });
});

describe("submitPullRequest happy path", () => {
  it("verifies origin, pushes the exact branch, then opens a PR and returns its url", async () => {
    const deps = okDeps();
    const res = await submitPullRequest(base, deps);
    // exact push command — no --force, no extra args (regression guard for injection)
    expect(deps.runGit).toHaveBeenNthCalledWith(1, "git remote get-url origin");
    expect(deps.runGit).toHaveBeenNthCalledWith(2, "git push -u origin deskmate/engineer/fix-typo");
    expect(deps.openPr).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/api", head: "deskmate/engineer/fix-typo", base: "main" }),
    );
    expect(res).toEqual({ url: "https://github.com/acme/api/pull/7" }); // only the url, no token/stdout
  });

  it("matches an exact owner/name allowlist entry", async () => {
    const deps = okDeps();
    await submitPullRequest({ ...base, allowlist: ["acme/api"] }, deps);
    expect(deps.openPr).toHaveBeenCalled();
  });

  it("rejects when the allowlist entry owner differs", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, allowlist: ["other/*"] }, deps)).rejects.toThrow(/allowlist/i);
  });
});

describe("parseGithubRepo", () => {
  it("parses https and ssh github remotes to owner/name", () => {
    expect(parseGithubRepo("https://github.com/acme/api.git")).toBe("acme/api");
    expect(parseGithubRepo("https://github.com/acme/api")).toBe("acme/api");
    expect(parseGithubRepo("git@github.com:acme/api.git")).toBe("acme/api");
    expect(parseGithubRepo("https://gitlab.com/acme/api.git")).toBeNull();
  });
});
