import { expect, it } from "vitest";
import { splitShellCommands } from "./split-shell-commands.ts";

it("splits a script into each command's words, keeping quoted text as one word", () => {
  expect(
    splitShellCommands(
      `pnpm test && gh pr create --title "Fix it" --body 'Run gh pr merge later' | cat; echo done\\ now`,
    ),
  ).toEqual([
    ["pnpm", "test"],
    [
      "gh",
      "pr",
      "create",
      "--title",
      "Fix it",
      "--body",
      "Run gh pr merge later",
    ],
    ["cat"],
    ["echo", "done now"],
  ]);
});

it("splits out the commands of substitutions, subshells and sh -c scripts", () => {
  expect(
    splitShellCommands(
      `echo "$(gh pr merge 1)" \`git push -f\` && (cd repo && bash -lc 'gh issue close 7') # gh pr merge 2`,
    ),
  ).toEqual([
    ["echo", "", ""],
    ["cd", "repo"],
    ["bash", "-lc", "gh issue close 7"],
    ["gh", "pr", "merge", "1"],
    ["git", "push", "-f"],
    ["gh", "issue", "close", "7"],
  ]);
});
