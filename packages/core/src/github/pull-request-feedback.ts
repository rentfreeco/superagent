import { z } from "zod";
import {
  PULL_REQUEST_INPUT_MAX_LENGTH,
  PULL_REQUEST_MAX_BOT_ROUNDS,
} from "../constants.ts";
import type { TaskState } from "../store/tasks.ts";
import { truncateText } from "../utils/truncate-text.ts";
import type { PullRequest, PullRequestSnapshot } from "./read-pull-request.ts";

export const pullRequestPositionSchema = z.object({
  ownership: z.enum(["ours", "foreign"]),
  isClosed: z.boolean(),
  updatedAt: z.string(),
  headSha: z.string(),
  hasPendingChecks: z.boolean(),
  lastReviewId: z.number(),
  lastReviewCommentId: z.number(),
  lastCommentId: z.number(),
  /** The newest updated_at among the comments read; a comment already seen and updated after it was edited. Positions saved before it fall back to updatedAt. */
  lastCommentUpdatedAt: z.string().optional(),
  seenCheckRunIds: z.array(z.number()),
  botRounds: z.number(),
});

/** What the watcher has already seen of one pull request, kept in kv. */
export interface PullRequestPosition extends z.infer<
  typeof pullRequestPositionSchema
> {}

export interface PullRequestFeedbackRequest {
  taskId: string;
  taskState: TaskState;
  snapshot: PullRequestSnapshot;
  position: PullRequestPosition | undefined;
  agentLogin: string;
  ownerLogin: string;
}

export interface PullRequestInput {
  ref: string;
  text: string;
}

export interface PullRequestNotice {
  dedupeKey: string;
  text: string;
}

export interface PullRequestFeedback {
  inputs: PullRequestInput[];
  notices: PullRequestNotice[];
  /** The pull request was merged or closed, so the task is over. */
  closesTask: boolean;
  position: PullRequestPosition;
}

type Author = "owner" | "bot" | "agent" | "other";

interface ItemAuthor {
  login: string;
  type: string;
}

interface Item {
  id: number;
  user: ItemAuthor | null;
}

interface EditableItem extends Item {
  updated_at: string;
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

const REVIEW_STATE_PHRASES: Readonly<Record<string, string>> = {
  CHANGES_REQUESTED: " and asked for changes",
  APPROVED: " and approved it",
};

/** Nothing read yet, so the first poll reads everything. */
export const UNREAD_POSITION: PullRequestPosition = {
  ownership: "ours",
  isClosed: false,
  updatedAt: "",
  headSha: "",
  hasPendingChecks: false,
  lastReviewId: 0,
  lastReviewCommentId: 0,
  lastCommentId: 0,
  lastCommentUpdatedAt: "",
  seenCheckRunIds: [],
  botRounds: 0,
};

const isTaskBranch = ({ head, base }: PullRequest, taskId: string) =>
  head.ref === `agent/${taskId}` &&
  head.repo?.full_name.toLowerCase() === base.repo.full_name.toLowerCase();

const lastId = (items: readonly Item[], previous: number) =>
  Math.max(previous, ...items.map(({ id }) => id));

const lastUpdatedAt = (items: readonly EditableItem[], previous: string) =>
  items.reduce(
    (latest, { updated_at }) => (updated_at > latest ? updated_at : latest),
    previous,
  );

/**
 * What a poll of a task's pull request means: the inputs that wake its
 * worker, the notices for its Slack thread, whether the task is over, and
 * what has now been seen.
 */
export const pullRequestFeedback = ({
  taskId,
  taskState,
  snapshot: { pullRequest, discussion, checkRuns },
  position,
  agentLogin,
  ownerLogin,
}: PullRequestFeedbackRequest): PullRequestFeedback => {
  const number = pullRequest.number;
  const seen = position ?? UNREAD_POSITION;
  if (position === undefined && !isTaskBranch(pullRequest, taskId)) {
    return {
      inputs: [],
      notices: [
        {
          dedupeKey: `pull-request-foreign:${taskId}:${number}`,
          text: `Pull request #${number} isn't on this task's branch, agent/${taskId}, so I won't follow its reviews or checks.`,
        },
      ],
      closesTask: false,
      position: { ...seen, ownership: "foreign" },
    };
  }
  if (pullRequest.state === "closed") {
    return {
      inputs: [],
      notices: [
        {
          dedupeKey: `pull-request-closed:${taskId}:${number}`,
          text: pullRequest.merged
            ? `Pull request #${number} was merged, so this task is done.`
            : `Pull request #${number} was closed without merging, so this task is done.`,
        },
      ],
      closesTask: true,
      position: { ...seen, isClosed: true },
    };
  }

  const authorOf = (user: Item["user"]): Author => {
    if (user === null) return "other";
    const login = user.login.toLowerCase();
    if (login === agentLogin.toLowerCase()) return "agent";
    if (login === ownerLogin.toLowerCase()) return "owner";
    return user.type === "Bot" ? "bot" : "other";
  };
  const isQuiet = taskState === "failed" || taskState === "stopped";
  const botsMayWake = !isQuiet && seen.botRounds < PULL_REQUEST_MAX_BOT_ROUNDS;
  const describeAuthor = (author: Author, login: string) =>
    author === "owner" ? "The owner" : `${login}, an automated reviewer,`;
  const body = (text: string) => {
    const trimmed = text.trim();
    return trimmed.length <= PULL_REQUEST_INPUT_MAX_LENGTH
      ? trimmed
      : `${truncateText(trimmed, PULL_REQUEST_INPUT_MAX_LENGTH)} (cut short: read the whole comment with gh)`;
  };

  const inputs: PullRequestInput[] = [];
  let hasBotInput = false;
  const take = (item: Item, text: (who: string) => string, ref: string) => {
    const author = authorOf(item.user);
    const login = item.user?.login ?? "";
    if (author === "owner" || (author === "bot" && botsMayWake)) {
      inputs.push({ ref, text: text(describeAuthor(author, login)) });
      hasBotInput ||= author === "bot";
    }
  };

  const editsAfter = seen.lastCommentUpdatedAt ?? seen.updatedAt;
  /** A new comment, an edit of one already seen, or undefined for neither. */
  const commentChange = (
    comment: EditableItem,
    kind: "comment" | "review-comment",
    lastSeenId: number,
  ) => {
    if (comment.id > lastSeenId) {
      return { verb: "commented", ref: `github:${kind}:${comment.id}` };
    }
    return comment.updated_at > editsAfter
      ? {
          verb: "edited a comment",
          ref: `github:${kind}:${comment.id}:edited:${comment.updated_at}`,
        }
      : undefined;
  };

  if (discussion !== undefined) {
    for (const review of discussion.reviews) {
      const text = review.body?.trim() ?? "";
      if (
        review.id <= seen.lastReviewId ||
        review.state === "PENDING" ||
        !text
      ) {
        continue;
      }
      take(
        review,
        (who) =>
          `${who} reviewed pull request #${number}${REVIEW_STATE_PHRASES[review.state] ?? ""}: ${body(text)}\n${review.html_url}`,
        `github:review:${review.id}`,
      );
    }
    for (const comment of discussion.reviewComments) {
      const change = commentChange(
        comment,
        "review-comment",
        seen.lastReviewCommentId,
      );
      if (change === undefined) continue;
      const where =
        comment.line === null
          ? comment.path
          : `${comment.path} line ${comment.line}`;
      take(
        comment,
        (who) =>
          `${who} ${change.verb} on ${where} in pull request #${number} (review comment ${comment.id}): ${body(comment.body)}\n${comment.html_url}`,
        change.ref,
      );
    }
    for (const comment of discussion.comments) {
      const text = comment.body?.trim() ?? "";
      const change = commentChange(comment, "comment", seen.lastCommentId);
      if (change === undefined || !text) continue;
      take(
        comment,
        (who) =>
          `${who} ${change.verb} on pull request #${number}: ${body(text)}\n${comment.html_url}`,
        change.ref,
      );
    }
  }

  const isNewHead = pullRequest.head.sha !== seen.headSha;
  const seenCheckRunIds = isNewHead ? [] : [...seen.seenCheckRunIds];
  if (checkRuns !== undefined) {
    for (const run of checkRuns) {
      const hasFailed =
        run.status === "completed" &&
        run.conclusion !== null &&
        FAILED_CONCLUSIONS.has(run.conclusion);
      if (!hasFailed || seenCheckRunIds.includes(run.id)) continue;
      seenCheckRunIds.push(run.id);
      if (isQuiet) continue;
      inputs.push({
        ref: `github:check-run:${run.id}`,
        text: `The check "${run.name}" failed on pull request #${number}'s head commit ${pullRequest.head.sha.slice(0, 7)}.${run.html_url === null ? "" : ` ${run.html_url}`}`,
      });
    }
  }

  return {
    inputs,
    notices: [],
    closesTask: false,
    position: {
      ...seen,
      updatedAt:
        discussion === undefined ? seen.updatedAt : pullRequest.updated_at,
      headSha: checkRuns === undefined ? seen.headSha : pullRequest.head.sha,
      hasPendingChecks:
        checkRuns === undefined
          ? seen.hasPendingChecks
          : checkRuns.some(({ status }) => status !== "completed"),
      lastReviewId: lastId(discussion?.reviews ?? [], seen.lastReviewId),
      lastReviewCommentId: lastId(
        discussion?.reviewComments ?? [],
        seen.lastReviewCommentId,
      ),
      lastCommentId: lastId(discussion?.comments ?? [], seen.lastCommentId),
      lastCommentUpdatedAt:
        discussion === undefined
          ? seen.lastCommentUpdatedAt
          : lastUpdatedAt(
              [...discussion.reviewComments, ...discussion.comments],
              editsAfter,
            ),
      seenCheckRunIds:
        checkRuns === undefined ? seen.seenCheckRunIds : seenCheckRunIds,
      botRounds: seen.botRounds + (hasBotInput ? 1 : 0),
    },
  };
};
