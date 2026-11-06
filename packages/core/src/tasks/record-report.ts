import type { Store } from "../store/open-store.ts";
import type { TaskState } from "../store/tasks.ts";

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

export interface ReportOutcome {
  isAccepted: boolean;
  reply: string;
}

export interface RecordReportOptions {
  store: Pick<Store, "transaction" | "tasks" | "reports" | "outbox">;
  taskId: string;
  report: WorkerReport;
}

const ACCEPTED_REPLY =
  "Posted to the Slack thread. End your turn now. If the owner replies, it arrives as your next message.";

const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\/?$/;

const readPullRequestNumber = (
  prUrl: string | undefined,
): number | undefined => {
  const pullRequestNumber = prUrl?.trim().match(PULL_REQUEST_URL)?.[1];
  return pullRequestNumber === undefined
    ? undefined
    : Number(pullRequestNumber);
};

const findProblem = ({
  state,
  question,
  prUrl,
}: WorkerReport): string | undefined => {
  if (state === "waiting" && !question?.trim()) {
    return "Not posted: a waiting report needs the one question you want the owner to answer.";
  }
  if (state === "ready" && readPullRequestNumber(prUrl) === undefined) {
    return "Not posted: a ready report needs the pull request's URL, like https://github.com/owner/name/pull/42.";
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
}: RecordReportOptions): ReportOutcome =>
  store.transaction(() => {
    const problem = findProblem(report);
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
    store.outbox.enqueue({
      dedupeKey: `report:${savedReport.id}`,
      channel: task.originChannel,
      threadTs: task.originTs,
      message: { kind: "post", text: describeReport(report) },
    });
    return { isAccepted: true, reply: ACCEPTED_REPLY };
  });
