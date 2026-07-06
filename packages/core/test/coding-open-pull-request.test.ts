import { describe, it, expect, vi } from "vitest";
import {
  submitPullRequest,
  readSandboxChanges,
  commitViaApi,
  type ChangedFile,
} from "../src/coding/open-pull-request.js";

const base = {
  repo: "acme/api",
  branch: "deskmate/engineer/fix-typo",
  title: "Fix typo",
  body: "why + how tested",
  commitMessage: "fix: typo",
  allowlist: ["acme/*"],
};

const oneChange: ChangedFile[] = [{ path: "a.ts", content: "AAA", encoding: "base64", mode: "100644" }];

function okDeps() {
  return {
    getDefaultBranch: vi.fn().mockResolvedValue("main"),
    readChangedFiles: vi.fn().mockResolvedValue(oneChange),
    pushCommit: vi.fn().mockResolvedValue(undefined),
    openPr: vi.fn().mockResolvedValue({ url: "https://github.com/acme/api/pull/7" }),
  };
}

describe("submitPullRequest guards", () => {
  it("refuses a branch that isn't a deskmate/<id>/<slug> feature branch", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "hotfix" }, deps)).rejects.toThrow(/deskmate\//i);
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
  });

  it("refuses a branch with an embedded newline or shell metacharacters", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "deskmate/e/x\nmalicious" }, deps)).rejects.toThrow();
    await expect(submitPullRequest({ ...base, branch: "deskmate/e/x;rm -rf ~" }, deps)).rejects.toThrow();
    expect(deps.pushCommit).not.toHaveBeenCalled();
  });

  it("refuses a repo that isn't a plain owner/name", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, repo: "acme/api/../evil" }, deps)).rejects.toThrow(/owner\/name/i);
    await expect(submitPullRequest({ ...base, repo: "acme/api;rm" }, deps)).rejects.toThrow(/owner\/name/i);
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
  });

  it("refuses a repo outside the allowlist", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, repo: "evil/x" }, deps)).rejects.toThrow(/allowlist/i);
    expect(deps.pushCommit).not.toHaveBeenCalled();
  });

  it("refuses to use the base branch as the head", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "deskmate/x/y", base: "deskmate/x/y" }, deps)).rejects.toThrow(
      /base branch/i,
    );
    expect(deps.pushCommit).not.toHaveBeenCalled();
  });

  it("refuses when there are no changes to submit", async () => {
    const deps = okDeps();
    deps.readChangedFiles.mockResolvedValueOnce([]);
    await expect(submitPullRequest(base, deps)).rejects.toThrow(/no changes/i);
    expect(deps.pushCommit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });
});

describe("submitPullRequest happy path", () => {
  it("resolves the default branch, commits via API, opens a PR, returns the url", async () => {
    const deps = okDeps();
    const res = await submitPullRequest(base, deps);
    expect(deps.getDefaultBranch).toHaveBeenCalledWith("acme/api");
    expect(deps.readChangedFiles).toHaveBeenCalledWith("main");
    expect(deps.pushCommit).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/api", base: "main", branch: "deskmate/engineer/fix-typo", files: oneChange }),
    );
    expect(deps.openPr).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "acme/api", head: "deskmate/engineer/fix-typo", base: "main" }),
    );
    expect(res).toEqual({ url: "https://github.com/acme/api/pull/7" });
  });

  it("uses an explicit base and does not look up the default branch", async () => {
    const deps = okDeps();
    await submitPullRequest({ ...base, base: "develop" }, deps);
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
    expect(deps.pushCommit).toHaveBeenCalledWith(expect.objectContaining({ base: "develop" }));
  });
});

describe("readSandboxChanges", () => {
  function sandboxWith(stdout: string, exitCode = 0) {
    return {
      run: vi.fn().mockResolvedValue({ stdout, exitCode }),
      readBinaryFile: vi.fn(async ({ path }: { path: string }) => new TextEncoder().encode(`body:${path}`)),
    };
  }

  it("parses added/modified as base64 blobs and deleted as null (no writes, no shell paths)", async () => {
    const sandbox = sandboxWith("A\0a.ts\0M\0b.ts\0D\0c.ts\0");
    const files = await readSandboxChanges(sandbox, "main");
    expect(sandbox.run).toHaveBeenCalledWith({ command: expect.stringContaining("git diff --name-status -z") });
    expect(files).toEqual([
      { path: "a.ts", content: Buffer.from("body:a.ts").toString("base64"), encoding: "base64", mode: "100644" },
      { path: "b.ts", content: Buffer.from("body:b.ts").toString("base64"), encoding: "base64", mode: "100644" },
      { path: "c.ts", content: null, encoding: "utf-8", mode: "100644" },
    ]);
    expect(sandbox.readBinaryFile).toHaveBeenCalledTimes(2); // not for the delete
  });

  it("expands a rename into delete-old + add-new", async () => {
    const sandbox = sandboxWith("R100\0old.ts\0new.ts\0");
    const files = await readSandboxChanges(sandbox, "main");
    expect(files.map((f) => [f.path, f.content === null])).toEqual([
      ["old.ts", true],
      ["new.ts", false],
    ]);
  });

  it("throws when the diff command fails", async () => {
    const sandbox = sandboxWith("", 128);
    await expect(readSandboxChanges(sandbox, "main")).rejects.toThrow(/could not diff/i);
  });
});

describe("commitViaApi", () => {
  it("builds one commit (blobs + tree with deletes) and moves the branch ref", async () => {
    const api = {
      getRefSha: vi.fn().mockResolvedValue("basesha"),
      getCommitTreeSha: vi.fn().mockResolvedValue("basetree"),
      createBlob: vi.fn(async (c: string) => `blob-${c}`),
      createTree: vi.fn().mockResolvedValue("newtree"),
      createCommit: vi.fn().mockResolvedValue("newcommit"),
      upsertBranchRef: vi.fn().mockResolvedValue(undefined),
    };
    await commitViaApi(api, {
      base: "main",
      branch: "deskmate/e/x",
      message: "msg",
      files: [
        { path: "a.ts", content: "AAA", encoding: "base64", mode: "100644" },
        { path: "gone.ts", content: null, encoding: "utf-8", mode: "100644" },
      ],
    });
    expect(api.getRefSha).toHaveBeenCalledWith("heads/main");
    expect(api.getCommitTreeSha).toHaveBeenCalledWith("basesha");
    expect(api.createBlob).toHaveBeenCalledTimes(1); // only the content file, not the delete
    expect(api.createTree).toHaveBeenCalledWith(
      "basetree",
      expect.arrayContaining([
        expect.objectContaining({ path: "a.ts", sha: "blob-AAA" }),
        expect.objectContaining({ path: "gone.ts", sha: null }),
      ]),
    );
    expect(api.createCommit).toHaveBeenCalledWith("msg", "newtree", ["basesha"]);
    expect(api.upsertBranchRef).toHaveBeenCalledWith("deskmate/e/x", "newcommit");
  });
});
