import { z } from "zod";
import type { GitHubReaction, OutboxGitHubDelivery } from "../outbox/sender.ts";
import { type GitHubClient, GitHubRequestError } from "./client.ts";

export interface GitHubDeliveryOptions {
  client: GitHubClient;
  agentLogin: string;
}

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable(),
});

const reactionSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullable(),
});

const RETRIED_STATUSES = new Set([403, 408, 429]);

const markerFor = (dedupeKey: string) => `<!-- superagent:${dedupeKey} -->`;

const reactionsPath = ({ repository, subject, subjectId }: GitHubReaction) =>
  subject === "issue-comment"
    ? `/repos/${repository}/issues/comments/${subjectId}/reactions`
    : `/repos/${repository}/pulls/comments/${subjectId}/reactions`;

export const createGitHubDelivery = ({
  client,
  agentLogin,
}: GitHubDeliveryOptions): OutboxGitHubDelivery => {
  const isAgent = (user: { login: string } | null) =>
    user?.login.toLowerCase() === agentLogin.toLowerCase();
  return {
    comment: async ({ repository, issueNumber, text, dedupeKey }) => {
      await client.post(
        `/repos/${repository}/issues/${issueNumber}/comments`,
        { body: `${text}\n\n${markerFor(dedupeKey)}` },
        commentSchema,
      );
    },
    hasComment: async ({ repository, issueNumber, dedupeKey, postedAfter }) => {
      const comments = await client.get(
        `/repos/${repository}/issues/${issueNumber}/comments?since=${new Date(postedAfter).toISOString()}&per_page=100`,
        z.array(commentSchema),
      );
      return comments.some(
        ({ body, user }) =>
          isAgent(user) && (body ?? "").includes(markerFor(dedupeKey)),
      );
    },
    react: async (reaction) => {
      await client.post(
        reactionsPath(reaction),
        { content: reaction.content },
        reactionSchema,
      );
    },
    unreact: async (reaction) => {
      const path = reactionsPath(reaction);
      const reactions = await client.get(
        `${path}?content=${encodeURIComponent(reaction.content)}&per_page=100`,
        z.array(reactionSchema),
      );
      for (const { id, user } of reactions) {
        if (isAgent(user)) await client.delete(`${path}/${id}`);
      }
    },
    classifyFailure: (error) =>
      error instanceof GitHubRequestError &&
      error.status < 500 &&
      !RETRIED_STATUSES.has(error.status)
        ? { kind: "permanent" }
        : { kind: "transient" },
  };
};
