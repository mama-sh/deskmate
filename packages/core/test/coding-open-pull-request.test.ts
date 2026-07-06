import { describe, it, expect, vi } from "vitest";
import { submitPullRequest } from "../src/coding/open-pull-request.js";

const base = {
  repo: "acme/api",
  branch: "deskmate/engineer/fix-typo",
  base: "main",
  title: "Fix typo",
  body: "why + how tested",
  allowlist: ["acme/*"],
};

function okDeps() {
  return {
    runGit: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    openPr: vi.fn().mockResolvedValue({ url: "https://github.com/acme/api/pull/7" }),
  };
}

describe("submitPullRequest", () => {
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

  it("refuses a repo outside the allowlist", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, repo: "evil/x" }, deps)).rejects.toThrow(/allowlist/i);
    expect(deps.runGit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("pushes the feature branch then opens a PR and returns its url", async () => {
    const deps = okDeps();
    const res = await submitPullRequest(base, deps);
    expect(deps.runGit).toHaveBeenCalledWith(expect.stringContaining("push"));
    expect(deps.runGit).toHaveBeenCalledWith(expect.stringContaining("deskmate/engineer/fix-typo"));
    expect(deps.openPr).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/api", head: "deskmate/engineer/fix-typo", base: "main" }),
    );
    expect(res.url).toBe("https://github.com/acme/api/pull/7");
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
