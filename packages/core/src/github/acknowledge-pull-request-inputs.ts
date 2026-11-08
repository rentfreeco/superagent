import { z } from "zod";
import { TASK_ACK_REACTION } from "../constants.ts";
import type { GitHubClient } from "./client.ts";

export interface PullRequestAcknowledgement {
  client: GitHubClient;
  /** owner/name */
  repository: string;
  /** Input refs, such as github:comment:31; ones that can't take a reaction are skipped. */
  refs: readonly string[];
}

const reactionSchema = z.object({ id: z.number() });

/** Where a reaction on the GitHub item behind an input goes; reviews and check runs can't take one. */
export const reactionPathFor = (
  repository: string,
  ref: string,
): string | undefined => {
  const [, kind, id] =
    ref.match(/^github:(comment|review-comment):(\d+)$/) ?? [];
  if (kind === "comment") {
    return `/repos/${repository}/issues/comments/${id}/reactions`;
  }
  if (kind === "review-comment") {
    return `/repos/${repository}/pulls/comments/${id}/reactions`;
  }
  return undefined;
};

/**
 * Puts 👀 on the comments behind the given inputs, as the agent. GitHub
 * keeps one reaction per account, so reacting twice changes nothing.
 * Returns the refs it reacted to.
 */
export const acknowledgePullRequestInputs = async ({
  client,
  repository,
  refs,
}: PullRequestAcknowledgement): Promise<string[]> => {
  const acknowledged: string[] = [];
  for (const ref of refs) {
    const path = reactionPathFor(repository, ref);
    if (path === undefined) continue;
    await client.post(path, { content: TASK_ACK_REACTION }, reactionSchema);
    acknowledged.push(ref);
  }
  return acknowledged;
};
