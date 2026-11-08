import type { GitHubSubject } from "../store/outbox.ts";

export interface PullRequestInputSubject {
  subject: GitHubSubject;
  subjectId: number;
}

/** The comment behind a GitHub input's ref, new or edited, which can take a reaction; undefined for reviews and check runs. */
export const pullRequestInputSubject = (
  ref: string,
): PullRequestInputSubject | undefined => {
  const [, kind, id] =
    ref.match(/^github:(comment|review-comment):(\d+)(?::edited:.+)?$/) ?? [];
  if (kind === undefined || id === undefined) return undefined;
  return {
    subject: kind === "comment" ? "issue-comment" : "review-comment",
    subjectId: Number(id),
  };
};
