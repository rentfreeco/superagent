import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { agentAccountEnvironment } from "./agent-account-environment.ts";

const runFile = promisify(execFile);

const account = {
  token: "ghp_agent_token",
  login: "superagent-bot",
  email: "4242+superagent-bot@users.noreply.github.com",
};

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const runGit = async (args: string[], input?: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-account-"));
  directories.push(directory);
  const child = runFile("git", args, {
    cwd: directory,
    env: { ...process.env, ...agentAccountEnvironment(account) },
  });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout;
};

describe("agentAccountEnvironment", () => {
  it("makes gh and commits act as the agent", () => {
    expect(agentAccountEnvironment(account)).toMatchObject({
      GH_TOKEN: "ghp_agent_token",
      GIT_AUTHOR_NAME: "superagent-bot",
      GIT_AUTHOR_EMAIL: "4242+superagent-bot@users.noreply.github.com",
      GIT_COMMITTER_NAME: "superagent-bot",
      GIT_COMMITTER_EMAIL: "4242+superagent-bot@users.noreply.github.com",
    });
  });

  it("gives git the agent's token for GitHub, over any credential helper the machine has", async () => {
    const credential = await runGit(
      ["credential", "fill"],
      "protocol=https\nhost=github.com\n\n",
    );

    expect(credential).toContain("username=x-access-token\n");
    expect(credential).toContain("password=ghp_agent_token\n");
  });

  it("sends SSH remotes for GitHub over https, so the machine's SSH key isn't used", async () => {
    expect(
      await runGit([
        "ls-remote",
        "--get-url",
        "git@github.com:pakgin/scratch.git",
      ]),
    ).toBe("https://github.com/pakgin/scratch.git\n");
    expect(
      await runGit([
        "ls-remote",
        "--get-url",
        "ssh://git@github.com/pakgin/scratch.git",
      ]),
    ).toBe("https://github.com/pakgin/scratch.git\n");
  });
});
