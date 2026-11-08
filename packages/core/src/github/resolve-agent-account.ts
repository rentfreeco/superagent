import { z } from "zod";
import { GITHUB_NOREPLY_EMAIL_DOMAIN } from "../constants.ts";
import type { GitHubClient } from "./client.ts";

export interface AgentAccount {
  token: string;
  login: string;
  /** GitHub's noreply address for the account, which commits are authored with. */
  email: string;
}

export interface AgentAccountRequest {
  client: GitHubClient;
  token: string;
  ownerLogin: string;
}

const userSchema = z.object({ login: z.string(), id: z.number() });

/** The GitHub account the agent's token belongs to, refusing the owner's own. */
export const resolveAgentAccount = async ({
  client,
  token,
  ownerLogin,
}: AgentAccountRequest): Promise<AgentAccount> => {
  const { login, id } = await client.get("/user", userSchema);
  if (login.toLowerCase() === ownerLogin.toLowerCase()) {
    throw new Error(
      `github: the agent's token belongs to the owner's account, ${login}. Use a token for superagent's own GitHub account, so its pull requests aren't yours and you can review them.`,
    );
  }
  return {
    token,
    login,
    email: `${id}+${login}@${GITHUB_NOREPLY_EMAIL_DOMAIN}`,
  };
};
