import {
  PULL_REQUEST_CHECKS_RECHECK_INTERVAL_MS,
  PULL_REQUEST_POLL_INTERVAL_MS,
} from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { Store } from "../store/open-store.ts";
import type { Task } from "../store/tasks.ts";
import { closeTask } from "../tasks/close-task.ts";
import { describeError } from "../utils/describe-error.ts";
import type { GitHubClient } from "./client.ts";
import {
  isTaskBranch,
  pullRequestFeedback,
  pullRequestPositionSchema,
} from "./pull-request-feedback.ts";
import { type PullRequest, readPullRequest } from "./read-pull-request.ts";

export interface PullRequestWatcherLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface PullRequestWatcherOptions {
  store: Pick<Store, "transaction" | "tasks" | "inputs" | "outbox" | "kv">;
  client: GitHubClient;
  /** Repo name -> Repo. */
  repos: ReadonlyMap<string, Repo>;
  agentLogin: string;
  ownerLogin: string;
  wakeOutbox: () => void;
  wakeTaskRunner: () => void;
  logger: PullRequestWatcherLogger;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface PullRequestWatcher {
  start(): void;
  /** One pass over every followed pull request; resolves when it's done. */
  poll(): Promise<void>;
  stop(): Promise<void>;
}

export const pullRequestPositionKey = (taskId: string, number: number) =>
  `pull_request:${taskId}:${number}`;

export const createPullRequestWatcher = ({
  store,
  client,
  repos,
  agentLogin,
  ownerLogin,
  wakeOutbox,
  wakeTaskRunner,
  logger,
  pollIntervalMs = PULL_REQUEST_POLL_INTERVAL_MS,
  now = Date.now,
}: PullRequestWatcherOptions): PullRequestWatcher => {
  let pollTimer: NodeJS.Timeout | undefined;
  let currentPoll: Promise<void> | undefined;

  const pollTask = async (task: Task, number: number): Promise<void> => {
    const repo = repos.get(task.repo);
    if (repo === undefined) return;
    const key = pullRequestPositionKey(task.id, number);
    const position = store.kv.get(key, pullRequestPositionSchema);
    if (position?.isClosed || position?.ownership === "foreign") return;
    const readAt = now();
    const areChecksStale =
      readAt - (position?.checksReadAt ?? 0) >=
      PULL_REQUEST_CHECKS_RECHECK_INTERVAL_MS;
    /** Reviews, comments, and checks only matter on an open pull request that is the task's, so a closed or foreign one is settled without them. */
    const isFollowed = (pullRequest: PullRequest) =>
      pullRequest.state === "open" &&
      (position !== undefined || isTaskBranch(pullRequest, task.id));
    const snapshot = await readPullRequest({
      client,
      repository: repo.github,
      number,
      shouldReadDiscussion: (pullRequest) =>
        isFollowed(pullRequest) &&
        pullRequest.updated_at !== position?.updatedAt,
      shouldReadChecks: (pullRequest) =>
        isFollowed(pullRequest) &&
        (pullRequest.head.sha !== position?.headSha ||
          position.hasPendingChecks ||
          areChecksStale),
    });
    const hasNews = store.transaction(() => {
      const current = store.tasks.get(task.id);
      if (current === undefined) return false;
      const feedback = pullRequestFeedback({
        taskId: task.id,
        taskState: current.state,
        snapshot,
        position,
        agentLogin,
        ownerLogin,
        readAt,
      });
      const addedInputs = feedback.inputs.filter(
        ({ ref, text }) =>
          store.inputs.add({ taskId: task.id, source: "github", ref, text }) !==
          undefined,
      );
      const queuedNotices = feedback.notices.filter(
        ({ dedupeKey, text }) =>
          store.outbox.enqueue({
            dedupeKey,
            channel: current.originChannel,
            threadTs: current.originTs,
            message: { kind: "post", text },
          }) !== undefined,
      );
      if (feedback.closesTask) closeTask({ store, taskId: task.id });
      store.kv.set(key, feedback.position);
      return (
        addedInputs.length > 0 ||
        queuedNotices.length > 0 ||
        feedback.closesTask
      );
    });
    if (hasNews) {
      wakeOutbox();
      wakeTaskRunner();
    }
  };

  const pollAll = async (): Promise<void> => {
    for (const task of store.tasks.withPullRequest()) {
      if (task.prNumber === null) continue;
      try {
        await pollTask(task, task.prNumber);
      } catch (error) {
        logger.error(
          `github: polling ${task.id}'s pull request #${task.prNumber} failed: ${describeError(error)}`,
        );
      }
    }
  };

  const poll = (): Promise<void> => {
    currentPoll ??= pollAll().finally(() => {
      currentPoll = undefined;
    });
    return currentPoll;
  };

  return {
    start: () => {
      if (pollTimer !== undefined) {
        throw new Error("The pull request watcher is already running.");
      }
      pollTimer = setInterval(() => void poll(), pollIntervalMs);
      void poll();
    },
    poll,
    stop: async () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
      await currentPoll;
    },
  };
};
