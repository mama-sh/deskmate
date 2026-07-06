import { describe, it, expect, vi } from "vitest";
import {
  submitPullRequest,
  readSandboxChanges,
  readSandboxOrigin,
  parseGithubRepo,
  commitViaApi,
  type ChangedFile,
} from "../src/coding/open-pull-request.js";

const base = {
  repo: "acme/api",
  branch: "deskmate/engineer/fix-typo",
  title: "Fix typo",
  body: "why + how tested",
  commitMessage: "fix: typo",
  deskmateId: "engineer",
  allowlist: ["acme/*"],
};

const oneChange: ChangedFile[] = [{ path: "a.ts", content: "AAA", encoding: "base64", mode: "100644" }];

function okDeps() {
  return {
    getOriginRepo: vi.fn().mockResolvedValue("acme/api"),
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

  it("refuses a branch outside this deskmate's namespace", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, branch: "deskmate/other/foo" }, deps)).rejects.toThrow(/namespace/i);
    expect(deps.getOriginRepo).not.toHaveBeenCalled();
  });

  it("refuses to use the base branch as the head", async () => {
    const deps = okDeps();
    await expect(
      submitPullRequest({ ...base, branch: "deskmate/engineer/y", base: "deskmate/engineer/y" }, deps),
    ).rejects.toThrow(/base branch/i);
    expect(deps.pushCommit).not.toHaveBeenCalled();
  });

  it("refuses when there are no changes to submit", async () => {
    const deps = okDeps();
    deps.readChangedFiles.mockResolvedValueOnce([]);
    await expect(submitPullRequest(base, deps)).rejects.toThrow(/no changes/i);
    expect(deps.pushCommit).not.toHaveBeenCalled();
    expect(deps.openPr).not.toHaveBeenCalled();
  });

  it("refuses a base branch with shell metacharacters (diff-command injection guard)", async () => {
    const deps = okDeps();
    await expect(submitPullRequest({ ...base, base: 'main"; rm -rf ~' }, deps)).rejects.toThrow(/valid branch name/i);
    expect(deps.readChangedFiles).not.toHaveBeenCalled();
  });

  it("refuses when the sandbox has a DIFFERENT repo checked out than the approved one", async () => {
    const deps = okDeps();
    deps.getOriginRepo.mockResolvedValueOnce("acme/other");
    await expect(submitPullRequest(base, deps)).rejects.toThrow(/refusing to apply a diff across repos/i);
    expect(deps.readChangedFiles).not.toHaveBeenCalled();
    expect(deps.pushCommit).not.toHaveBeenCalled();
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
  function sandboxWith(diffStdout: string, opts: { diffExit?: number; dirtyExit?: number } = {}) {
    return {
      run: vi.fn(async ({ command }: { command: string }) =>
        command.includes("--quiet")
          ? { stdout: "", exitCode: opts.dirtyExit ?? 0 }
          : { stdout: diffStdout, exitCode: opts.diffExit ?? 0 },
      ),
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

  it("rejects a dirty working tree (uncommitted changes to tracked files)", async () => {
    const sandbox = sandboxWith("A\0a.ts\0", { dirtyExit: 1 });
    await expect(readSandboxChanges(sandbox, "main")).rejects.toThrow(/uncommitted changes/i);
    expect(sandbox.readBinaryFile).not.toHaveBeenCalled();
  });

  it("throws when the diff command fails", async () => {
    const sandbox = sandboxWith("", { diffExit: 128 });
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
      createBranchRef: vi.fn().mockResolvedValue(undefined),
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
    expect(api.createBranchRef).toHaveBeenCalledWith("deskmate/e/x", "newcommit");
  });
});

describe("readSandboxOrigin", () => {
  it("returns the owner/name of the sandbox origin remote", async () => {
    const sandbox = {
      run: vi.fn().mockResolvedValue({ stdout: "https://github.com/acme/api.git\n", exitCode: 0 }),
      readBinaryFile: vi.fn(),
    };
    expect(await readSandboxOrigin(sandbox)).toBe("acme/api");
    expect(sandbox.run).toHaveBeenCalledWith({ command: "git remote get-url origin" });
  });

  it("returns null when there is no origin", async () => {
    const sandbox = { run: vi.fn().mockResolvedValue({ stdout: "", exitCode: 128 }), readBinaryFile: vi.fn() };
    expect(await readSandboxOrigin(sandbox)).toBeNull();
  });
});

describe("parseGithubRepo", () => {
  it("parses https and ssh github remotes to owner/name", () => {
    expect(parseGithubRepo("https://github.com/acme/api.git")).toBe("acme/api");
    expect(parseGithubRepo("https://github.com/acme/api")).toBe("acme/api");
    expect(parseGithubRepo("git@github.com:acme/api.git")).toBe("acme/api");
    expect(parseGithubRepo("https://gitlab.com/acme/api.git")).toBeNull();
  });

  it("requires github.com to be the actual host (rejects a crafted lookalike path)", () => {
    expect(parseGithubRepo("https://evil.example/github.com/acme/api.git")).toBeNull();
    expect(parseGithubRepo("https://x-access-token:tok@github.com/acme/api.git")).toBe("acme/api");
  });
});
