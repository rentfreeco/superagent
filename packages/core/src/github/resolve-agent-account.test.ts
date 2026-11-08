import { describe, expect, it } from "vitest";
import type { GitHubClient } from "./client.ts";
import { resolveAgentAccount } from "./resolve-agent-account.ts";

const clientFor = (login: string): GitHubClient => ({
  get: async (_path, schema) => schema.parse({ login, id: 4242 }),
  post: async () => {
    throw new Error("resolveAgentAccount only reads");
  },
});

describe("resolveAgentAccount", () => {
  it("returns the token's account, with GitHub's noreply address for commits", async () => {
    expect(
      await resolveAgentAccount({
        client: clientFor("superagent-bot"),
        token: "ghp_agent",
        ownerLogin: "pakgin",
      }),
    ).toEqual({
      token: "ghp_agent",
      login: "superagent-bot",
      email: "4242+superagent-bot@users.noreply.github.com",
    });
  });

  it("refuses a token that belongs to the owner, whatever the case", async () => {
    await expect(
      resolveAgentAccount({
        client: clientFor("Pakgin"),
        token: "ghp_owner",
        ownerLogin: "pakgin",
      }),
    ).rejects.toThrow(/belongs to the owner's account, Pakgin/);
  });
});
