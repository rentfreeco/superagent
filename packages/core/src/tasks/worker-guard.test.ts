import { describe, expect, it } from "vitest";
import { createWorkerGuard, refusalFor } from "./worker-guard.ts";

const options = {
  worktreePath: "/data/worktrees/abcd2345",
  gitDirectory: "/code/superagent/.git",
  baseBranch: "main",
  homeDirectory: "/home/agent",
};

const bash = (command: string) => refusalFor("Bash", { command }, options);

describe("refusalFor", () => {
  it.each([
    "gh pr merge 42 --squash",
    "gh pr merge --auto --merge 42",
    "gh pr review 42 --approve",
    "gh issue close 7",
    "gh repo delete pakgin/superagent --yes",
    "git push --force origin agent/abcd2345",
    "git push -f",
    "git push origin +agent/abcd2345",
    "git push origin --delete agent/old",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin agent/abcd2345:refs/heads/main",
    "pnpm test && git push origin main",
  ])("refuses `%s`", (command) => {
    expect(bash(command)).toEqual(expect.any(String));
  });

  it.each([
    "git push -u origin agent/abcd2345",
    "git push --force-with-lease=agent/abcd2345:abc123 origin agent/abcd2345",
    "gh pr create --base main --title 'Fix the flaky test'",
    "gh pr view 42 --json reviews",
    "git log main..HEAD",
    "git checkout -b agent/abcd2345 origin/main",
    "git push origin agent/maintenance",
  ])("allows `%s`", (command) => {
    expect(bash(command)).toBeUndefined();
  });

  it("refuses writes outside the worktree and its git directory", () => {
    expect(
      refusalFor("Edit", { file_path: "src/index.ts" }, options),
    ).toBeUndefined();
    expect(
      refusalFor(
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
      expect(refusalFor(toolName, input, options)).toMatch(
        /outside your worktree/,
      );
    }
  });

  it("refuses reads of credential files, and allows other reads", () => {
    for (const [toolName, input] of [
      ["Read", { file_path: "~/.ssh/id_ed25519" }],
      ["Read", { file_path: "/home/agent/.config/gh/hosts.yml" }],
      ["Grep", { path: "/home/agent/.aws" }],
      ["Read", { file_path: "/home/agent/.netrc" }],
    ] as const) {
      expect(refusalFor(toolName, input, options)).toMatch(/credential/);
    }
    expect(
      refusalFor("Read", { file_path: "/code/superagent/README.md" }, options),
    ).toBeUndefined();
    expect(
      refusalFor(
        "Read",
        { file_path: "/home/agent/.sshconfig-notes" },
        options,
      ),
    ).toBeUndefined();
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
