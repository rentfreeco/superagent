import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Repo } from "../repos/config.ts";
import { createKeyedLock } from "../utils/create-keyed-lock.ts";
import { isGitCheckout } from "../utils/is-git-checkout.ts";
import { runGit } from "../utils/run-git.ts";

export interface WorktreeRequest {
  repo: Repo;
  taskId: string;
  worktreesDirectory: string;
}

export interface Worktree {
  branch: string;
  path: string;
}

export type PrepareWorktree = (request: WorktreeRequest) => Promise<Worktree>;

const lockCheckout = createKeyedLock();

export const prepareWorktree: PrepareWorktree = async ({
  repo,
  taskId,
  worktreesDirectory,
}) => {
  const worktree = {
    branch: `agent/${taskId}`,
    path: path.join(worktreesDirectory, taskId),
  };
  if (await isGitCheckout(worktree.path)) return worktree;
  await mkdir(worktreesDirectory, { recursive: true });
  return lockCheckout(repo.path, async () => {
    await runGit(repo.path, ["worktree", "prune"]);
    const existingBranch = await runGit(repo.path, [
      "branch",
      "--list",
      worktree.branch,
    ]);
    if (existingBranch !== "") {
      await runGit(repo.path, [
        "worktree",
        "add",
        worktree.path,
        worktree.branch,
      ]);
      return worktree;
    }
    const baseRef = `refs/remotes/origin/${repo.baseBranch}`;
    await runGit(repo.path, [
      "fetch",
      "origin",
      `+refs/heads/${repo.baseBranch}:${baseRef}`,
    ]);
    await runGit(repo.path, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      worktree.branch,
      worktree.path,
      baseRef,
    ]);
    return worktree;
  });
};
