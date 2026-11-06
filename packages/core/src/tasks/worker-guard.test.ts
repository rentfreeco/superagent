import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createWorkerGuard,
  refusalFor,
  type WorkerGuardOptions,
} from "./worker-guard.ts";

const options: WorkerGuardOptions = {
  worktreePath: "/data/worktrees/abcd2345",
  gitDirectory: "/code/superagent/.git",
  baseBranch: "main",
  homeDirectory: "/home/agent",
};

const bash = (command: string) => refusalFor("Bash", { command }, options);

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const setupFiles = async (): Promise<WorkerGuardOptions> => {
  const root = await mkdtemp(path.join(tmpdir(), "superagent-guard-"));
  temporaryDirectories.push(root);
  const homeDirectory = path.join(root, "home");
  const worktreePath = path.join(root, "worktrees", "abcd2345");
  const outside = path.join(root, "outside");
  await mkdir(path.join(homeDirectory, ".aws"), { recursive: true });
  await writeFile(path.join(homeDirectory, ".aws", "credentials"), "secret");
  await mkdir(path.join(worktreePath, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "victim.txt"), "original");
  await symlink(
    path.join(outside, "victim.txt"),
    path.join(worktreePath, "link.txt"),
  );
  await symlink(outside, path.join(worktreePath, "linked-dir"));
  await symlink(
    path.join(homeDirectory, ".aws", "credentials"),
    path.join(worktreePath, "notes.txt"),
  );
  return {
    worktreePath,
    gitDirectory: path.join(root, "checkout", ".git"),
    baseBranch: "main",
    homeDirectory,
  };
};

describe("refusalFor commands", () => {
  it.each([
    "gh pr merge 42 --squash",
    "gh pr merge --auto --merge 42",
    "gh -R pakgin/superagent pr merge 42",
    "gh pr review 42 --approve",
    "gh issue close 7",
    "gh repo delete pakgin/superagent --yes",
    "git push --force origin agent/abcd2345",
    "git push -f",
    "git push -fu origin agent/abcd2345",
    "git push origin +agent/abcd2345",
    "git push origin --delete agent/old",
    "git push origin :agent/old",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin agent/abcd2345:refs/heads/main",
    "git -C /code/superagent push origin main",
    "pnpm test && git push origin main",
    "GH_TOKEN=x timeout 60 /usr/bin/gh pr merge 42",
    "bash -lc 'gh pr merge 42'",
    'echo "$(gh pr merge 42)"',
    "(cd /tmp && gh issue close 7)",
  ])("refuses `%s`", async (command) => {
    expect(await bash(command)).toEqual(expect.any(String));
  });

  it.each([
    "git push -u origin agent/abcd2345",
    "git push --force-with-lease=agent/abcd2345:abc123 origin agent/abcd2345",
    "gh pr create --base main --title 'Fix the flaky test'",
    'gh pr create --title "Document deployment" --body "Maintainers run gh pr merge after review"',
    'git commit -m "Never git push origin main from a worker"',
    "gh pr comment 42 --body 'Will gh issue close 7 once this merges'",
    "gh pr view 42 --json reviews",
    "git log main..HEAD",
    "git checkout -b agent/abcd2345 origin/main",
    "git push origin agent/maintenance",
    "echo gh pr merge",
  ])("allows `%s`", async (command) => {
    expect(await bash(command)).toBeUndefined();
  });
});

describe("refusalFor files", () => {
  it("refuses writes outside the worktree and its git directory", async () => {
    expect(
      await refusalFor("Edit", { file_path: "src/index.ts" }, options),
    ).toBeUndefined();
    expect(
      await refusalFor(
        "Write",
        { file_path: "/code/superagent/.git/worktrees/abcd2345/HEAD" },
        options,
      ),
    ).toBeUndefined();
    for (const [toolName, input] of [
      ["Write", { file_path: "/code/superagent/src/index.ts" }],
      ["Edit", { file_path: "../other-task/README.md" }],
      ["NotebookEdit", { notebook_path: "~/notes.ipynb" }],
    ] as const) {
      expect(await refusalFor(toolName, input, options)).toMatch(
        /outside your worktree/,
      );
    }
  });

  it("refuses reads of credential files, and allows other reads", async () => {
    for (const [toolName, input] of [
      ["Read", { file_path: "~/.ssh/id_ed25519" }],
      ["Read", { file_path: "/home/agent/.config/gh/hosts.yml" }],
      ["Grep", { path: "/home/agent/.aws" }],
      ["Read", { file_path: "/home/agent/.netrc" }],
    ] as const) {
      expect(await refusalFor(toolName, input, options)).toMatch(/credential/);
    }
    expect(
      await refusalFor(
        "Read",
        { file_path: "/code/superagent/README.md" },
        options,
      ),
    ).toBeUndefined();
    expect(
      await refusalFor(
        "Read",
        { file_path: "/home/agent/.sshconfig-notes" },
        options,
      ),
    ).toBeUndefined();
  });

  it("follows symlinks: no writing through a link that leaves the worktree, no reading credentials through one", async () => {
    const files = await setupFiles();

    expect(await refusalFor("Write", { file_path: "link.txt" }, files)).toMatch(
      /outside your worktree/,
    );
    expect(
      await refusalFor("Write", { file_path: "linked-dir/new.txt" }, files),
    ).toMatch(/outside your worktree/);
    expect(await refusalFor("Read", { file_path: "notes.txt" }, files)).toMatch(
      /credential/,
    );
    expect(
      await refusalFor("Write", { file_path: "src/new-file.ts" }, files),
    ).toBeUndefined();
  });

  it("refuses a search whose root holds credential files, and allows one inside the worktree", async () => {
    const files = await setupFiles();

    for (const toolName of ["Grep", "Glob"]) {
      expect(
        await refusalFor(toolName, { path: files.homeDirectory }, files),
      ).toMatch(/holds credential files/);
      expect(await refusalFor(toolName, { path: "/" }, files)).toMatch(
        /holds credential files/,
      );
      expect(
        await refusalFor(toolName, { path: files.worktreePath }, files),
      ).toBeUndefined();
    }
  });
});

describe("createWorkerGuard", () => {
  it("denies a refused tool call with its reason, and lets others through", async () => {
    const guard = createWorkerGuard(options);
    const signal = new AbortController().signal;
    const toolUse = (command: string) => ({
      hook_event_name: "PreToolUse" as const,
      session_id: "s-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: options.worktreePath,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "toolu_1",
    });

    expect(
      await guard(toolUse("gh pr merge 42"), "toolu_1", { signal }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Merging is the owner's call. Report ready instead.",
      },
    });
    expect(await guard(toolUse("pnpm test"), "toolu_1", { signal })).toEqual(
      {},
    );
  });
});
