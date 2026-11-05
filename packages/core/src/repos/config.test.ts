import { describe, expect, it } from "vitest";
import { parseConfig, type RepoConfig } from "./config.ts";

const superagentRepo: RepoConfig = {
  github: "pakgin/superagent",
  path: "~/code/superagent",
  baseBranch: "main",
};

const validConfig = {
  repos: { superagent: superagentRepo },
  channels: { C0123ABCD: "superagent" },
};

describe("parseConfig", () => {
  it("accepts channels that point at defined repos", () => {
    expect(parseConfig(validConfig)).toEqual(validConfig);
  });

  it("rejects a channel name used in place of a channel ID", () => {
    expect(() =>
      parseConfig({ ...validConfig, channels: { general: "superagent" } }),
    ).toThrow(/must be a Slack channel ID/);
  });

  it("rejects a channel that points at an undefined repo", () => {
    expect(() =>
      parseConfig({ ...validConfig, channels: { C0123ABCD: "repo2" } }),
    ).toThrow(/"repo2", which is not defined under repos/);
  });

  it("rejects a misspelled key instead of ignoring it", () => {
    const { baseBranch, ...repoWithoutBaseBranch } = superagentRepo;
    expect(() =>
      parseConfig({
        ...validConfig,
        repos: {
          superagent: { ...repoWithoutBaseBranch, baseBrnach: baseBranch },
        },
      }),
    ).toThrow(/baseBrnach/);
  });

  it("rejects a github value that isn't owner/name", () => {
    expect(() =>
      parseConfig({
        ...validConfig,
        repos: { superagent: { ...superagentRepo, github: "superagent" } },
      }),
    ).toThrow(/must be owner\/name/);
  });

  it("reports every schema problem in one error", () => {
    expect(() =>
      parseConfig({
        repos: { superagent: { ...superagentRepo, github: "superagent" } },
        channels: { general: "superagent" },
      }),
    ).toThrow(
      /must be owner\/name[\s\S]*must be a Slack channel ID|must be a Slack channel ID[\s\S]*must be owner\/name/,
    );
  });
});
