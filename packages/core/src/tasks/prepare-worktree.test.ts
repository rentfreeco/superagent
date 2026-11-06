import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Repo } from "../repos/config.ts";
import { runGit } from "../utils/run-git.ts";
import { prepareWorktree } from "./prepare-worktree.ts";

const AUTHOR = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const commitFile = async (
  directory: string,
  fileName: string,
): Promise<string> => {
  await writeFile(path.join(directory, fileName), fileName);
  await runGit(directory, ["add", fileName]);
  await runGit(directory, [...AUTHOR, "commit", "-m", `add ${fileName}`]);
  return runGit(directory, ["rev-parse", "HEAD"]);
};

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "superagent-worktree-"));
  temporaryDirectories.push(root);
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  const otherClone = path.join(root, "other-clone");
  await runGit(root, ["init", "--bare", "--initial-branch=main", origin]);
  await runGit(root, ["clone", origin, checkout]);
  await commitFile(checkout, "README.md");
  await runGit(checkout, ["push", "origin", "main"]);
  await runGit(root, ["clone", origin, otherClone]);
  const repo: Repo = {
    name: "superagent",
    github: "pakgin/superagent",
    path: checkout,
    baseBranch: "main",
  };
  const worktreesDirectory = path.join(root, "data", "worktrees");
  const prepare = () =>
    prepareWorktree({ repo, taskId: "abcd2345", worktreesDirectory });
  return { checkout, otherClone, prepare, worktreesDirectory };
};

describe("prepareWorktree", () => {
  it("adds a worktree on agent/<task id> from the freshly fetched base branch, with no upstream", async () => {
    const { otherClone, prepare, worktreesDirectory } = await setup();
    const latestMain = await commitFile(otherClone, "CHANGELOG.md");
    await runGit(otherClone, ["push", "origin", "main"]);

    const worktree = await prepare();

    expect(worktree).toEqual({
      branch: "agent/abcd2345",
      path: path.join(worktreesDirectory, "abcd2345"),
    });
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(latestMain);
    expect(await runGit(worktree.path, ["branch", "--show-current"])).toBe(
      "agent/abcd2345",
    );
    await expect(
      runGit(worktree.path, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    ).rejects.toThrow(/no upstream/);
  });

  it("returns a worktree that already exists as it is", async () => {
    const { prepare } = await setup();
    const worktree = await prepare();
    const workInProgress = await commitFile(worktree.path, "fix.ts");

    expect(await prepare()).toEqual(worktree);
    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(
      workInProgress,
    );
  });

  it("puts the task's existing branch back when its worktree directory is gone", async () => {
    const { prepare } = await setup();
    const worktree = await prepare();
    const workInProgress = await commitFile(worktree.path, "fix.ts");
    await rm(worktree.path, { recursive: true, force: true });

    await prepare();

    expect(await runGit(worktree.path, ["rev-parse", "HEAD"])).toBe(
      workInProgress,
    );
  });
});
