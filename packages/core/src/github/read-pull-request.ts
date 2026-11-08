import { z } from "zod";
import { GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from "../constants.ts";
import type { GitHubClient } from "./client.ts";

const authorSchema = z.object({ login: z.string(), type: z.string() });

const pullRequestSchema = z.object({
  number: z.number(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  updated_at: z.string(),
  html_url: z.string(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

const reviewSchema = z.object({
  id: z.number(),
  user: authorSchema.nullable(),
  body: z.string().nullable(),
  state: z.string(),
  html_url: z.string(),
});

const reviewCommentSchema = z.object({
  id: z.number(),
  user: authorSchema.nullable(),
  body: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  html_url: z.string(),
});

const issueCommentSchema = z.object({
  id: z.number(),
  user: authorSchema.nullable(),
  body: z.string().nullable(),
  html_url: z.string(),
});

const checkRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
});

const checkRunsSchema = z.object({ check_runs: z.array(checkRunSchema) });

export interface PullRequest extends z.infer<typeof pullRequestSchema> {}
export interface PullRequestReview extends z.infer<typeof reviewSchema> {}
export interface PullRequestReviewComment extends z.infer<
  typeof reviewCommentSchema
> {}
export interface PullRequestComment extends z.infer<
  typeof issueCommentSchema
> {}
export interface CheckRun extends z.infer<typeof checkRunSchema> {}

export interface PullRequestDiscussion {
  reviews: PullRequestReview[];
  reviewComments: PullRequestReviewComment[];
  comments: PullRequestComment[];
}

export interface PullRequestSnapshot {
  pullRequest: PullRequest;
  /** Undefined when not asked for. */
  discussion: PullRequestDiscussion | undefined;
  /** The head commit's check runs; undefined when not asked for. */
  checkRuns: CheckRun[] | undefined;
}

export interface PullRequestReadRequest {
  client: GitHubClient;
  /** owner/name */
  repository: string;
  number: number;
  /** Fetch reviews and comments, given the pull request as it is now. */
  shouldReadDiscussion: (pullRequest: PullRequest) => boolean;
  /** Fetch the head commit's check runs, given the pull request as it is now. */
  shouldReadChecks: (pullRequest: PullRequest) => boolean;
}

const getAllPages = async <Item extends z.ZodType>(
  client: GitHubClient,
  path: string,
  itemSchema: Item,
): Promise<z.output<Item>[]> => {
  const items: z.output<Item>[] = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const pageItems = await client.get(
      `${path}?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
      z.array(itemSchema),
    );
    items.push(...pageItems);
    if (pageItems.length < GITHUB_PAGE_SIZE) break;
  }
  return items;
};

/** One pull request, and only the parts of it the caller says have changed. */
export const readPullRequest = async ({
  client,
  repository,
  number,
  shouldReadDiscussion,
  shouldReadChecks,
}: PullRequestReadRequest): Promise<PullRequestSnapshot> => {
  const pullRequestPath = `/repos/${repository}/pulls/${number}`;
  const pullRequest = await client.get(pullRequestPath, pullRequestSchema);
  const [discussion, checkRuns] = await Promise.all([
    shouldReadDiscussion(pullRequest)
      ? Promise.all([
          getAllPages(client, `${pullRequestPath}/reviews`, reviewSchema),
          getAllPages(
            client,
            `${pullRequestPath}/comments`,
            reviewCommentSchema,
          ),
          getAllPages(
            client,
            `/repos/${repository}/issues/${number}/comments`,
            issueCommentSchema,
          ),
        ]).then(
          ([reviews, reviewComments, comments]): PullRequestDiscussion => ({
            reviews,
            reviewComments,
            comments,
          }),
        )
      : undefined,
    shouldReadChecks(pullRequest)
      ? client
          .get(
            `/repos/${repository}/commits/${pullRequest.head.sha}/check-runs?per_page=${GITHUB_PAGE_SIZE}`,
            checkRunsSchema,
          )
          .then(({ check_runs }) => check_runs)
      : undefined,
  ]);
  return { pullRequest, discussion, checkRuns };
};
