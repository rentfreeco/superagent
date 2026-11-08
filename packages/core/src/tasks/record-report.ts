import type { Store } from "../store/open-store.ts";
import type { TaskState } from "../store/tasks.ts";
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
  /** The worker answered on GitHub, so nothing is posted in Slack. */
  answeredOnGitHub?: boolean | undefined;
}

export interface RecordReportOptions {
  store: Pick<Store, "transaction" | "tasks" | "reports" | "outbox">;
  taskId: string;
  report: WorkerReport;
  /** The task's repo, owner/name; a pull request elsewhere isn't the task's. */
  repository?: string | undefined;
}

const ACCEPTED_REPLY =
  "Posted to the Slack thread. End your turn now. If the owner replies, it arrives as your next message.";
const ANSWERED_ON_GITHUB_REPLY =
  "Recorded without a Slack post, since you answered on GitHub. End your turn now.";

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
    if (report.answeredOnGitHub) {
      return { isAccepted: true, reply: ANSWERED_ON_GITHUB_REPLY };
    }
    store.outbox.enqueue({
      dedupeKey: `report:${savedReport.id}`,
      channel: task.originChannel,
      threadTs: task.originTs,
      message: { kind: "post", text: describeReport(report) },
    });
    return { isAccepted: true, reply: ACCEPTED_REPLY };
  });
