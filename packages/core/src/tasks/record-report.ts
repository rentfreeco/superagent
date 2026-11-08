import type { Store } from "../store/open-store.ts";
import type { TaskState } from "../store/tasks.ts";
import type { TaskPullRequest } from "./message-reactions.ts";
import type { ToolOutcome } from "./tool-outcome.ts";

export const REPORT_STATES = [
  "waiting",
  "ready",
  "done",
  "blocked",
  "failed",
] as const satisfies readonly TaskState[];

export type ReportState = (typeof REPORT_STATES)[number];

export interface WorkerReport {
  state: ReportState;
  summary: string;
  question?: string | undefined;
  prUrl?: string | undefined;
}

/** Where a report is posted: where the messages it answers came from. */
export interface ReportDestinations {
  slack: boolean;
  /** Post it on this pull request too, for messages that came from GitHub. */
  pullRequest: TaskPullRequest | undefined;
}

export interface RecordReportOptions {
  store: Pick<Store, "transaction" | "tasks" | "reports" | "outbox">;
  taskId: string;
  report: WorkerReport;
  /** The task's repo, owner/name; a pull request elsewhere isn't the task's. */
  repository?: string | undefined;
  /** Slack alone unless given. */
  destinations?: ReportDestinations | undefined;
}

const ACCEPTED_REPLIES = {
  slack:
    "Posted to the Slack thread. End your turn now. If the owner replies, it arrives as your next message.",
  pullRequest:
    "Posted on the pull request, where the messages came from. End your turn now.",
  both: "Posted to the Slack thread and on the pull request, where the messages came from. End your turn now.",
};

const SLACK_ONLY: ReportDestinations = { slack: true, pullRequest: undefined };

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;

const readPullRequestNumber = (
  prUrl: string | undefined,
): number | undefined => {
  const pullRequestNumber = prUrl?.trim().match(PULL_REQUEST_URL)?.[2];
  return pullRequestNumber === undefined
    ? undefined
    : Number(pullRequestNumber);
};

const readPullRequestRepository = (prUrl: string | undefined) =>
  prUrl?.trim().match(PULL_REQUEST_URL)?.[1];

const findProblem = (
  { state, question, prUrl }: WorkerReport,
  repository: string | undefined,
): string | undefined => {
  if (state === "waiting" && !question?.trim()) {
    return "Not posted: a waiting report needs the one question you want the owner to answer.";
  }
  if (state === "ready" && readPullRequestNumber(prUrl) === undefined) {
    return "Not posted: a ready report needs the pull request's URL, like https://github.com/owner/name/pull/42.";
  }
  const pullRequestRepository = readPullRequestRepository(prUrl);
  if (
    repository !== undefined &&
    pullRequestRepository !== undefined &&
    pullRequestRepository.toLowerCase() !== repository.toLowerCase()
  ) {
    return `Not posted: that pull request is in ${pullRequestRepository}, and this task's repo is ${repository}. Open it there, from your branch.`;
  }
  return undefined;
};

const describeReportForGitHub = ({
  state,
  summary,
  question,
}: WorkerReport): string => {
  switch (state) {
    case "waiting":
      return `${summary}\n\n**Question:** ${question}`;
    case "blocked":
      return `**Blocked:** ${summary}`;
    case "failed":
      return `**Failed:** ${summary}`;
    case "ready":
    case "done":
      return summary;
  }
};

const describeReport = ({
  state,
  summary,
  question,
  prUrl,
}: WorkerReport): string => {
  switch (state) {
    case "ready":
      return `${summary}\n<${prUrl?.trim()}|Pull request #${readPullRequestNumber(prUrl)}>`;
    case "waiting":
      return `${summary}\n\n*Question:* ${question}`;
    case "blocked":
      return `*Blocked:* ${summary}`;
    case "failed":
      return `*Failed:* ${summary}`;
    case "done":
      return summary;
  }
};

export const recordReport = ({
  store,
  taskId,
  report,
  repository,
  destinations = SLACK_ONLY,
}: RecordReportOptions): ToolOutcome =>
  store.transaction(() => {
    const problem = findProblem(report, repository);
    if (problem !== undefined) return { isAccepted: false, reply: problem };
    const task = store.tasks.get(taskId);
    if (task === undefined) throw new Error(`No task ${taskId}`);
    if (task.state !== "running") {
      return {
        isAccepted: false,
        reply: `Not posted: this task is ${task.state}. Stop working and end your turn.`,
      };
    }
    const savedReport = store.reports.add({
      taskId,
      state: report.state,
      summary: report.summary,
      question: report.question ?? null,
    });
    const prNumber = readPullRequestNumber(report.prUrl);
    if (prNumber !== undefined) store.tasks.update(taskId, { prNumber });
    store.tasks.transition(taskId, report.state);
    const { pullRequest } = destinations;
    if (destinations.slack) {
      store.outbox.enqueue({
        dedupeKey: `report:${savedReport.id}`,
        channel: task.originChannel,
        threadTs: task.originTs,
        message: { kind: "post", text: describeReport(report) },
      });
    }
    if (pullRequest !== undefined) {
      store.outbox.enqueue({
        dedupeKey: `report:${savedReport.id}:github`,
        channel: `github:${pullRequest.repository}`,
        threadTs: String(pullRequest.number),
        message: {
          kind: "github_comment",
          repository: pullRequest.repository,
          issueNumber: pullRequest.number,
          text: describeReportForGitHub(report),
        },
      });
    }
    return {
      isAccepted: true,
      reply:
        pullRequest === undefined
          ? ACCEPTED_REPLIES.slack
          : destinations.slack
            ? ACCEPTED_REPLIES.both
            : ACCEPTED_REPLIES.pullRequest,
    };
  });
