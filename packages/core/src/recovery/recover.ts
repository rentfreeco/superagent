import { RECOVERY_ENDED_TASK_WINDOW_MS } from "../constants.ts";
import type { StoredEvent } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import type { TaskState } from "../store/tasks.ts";
import { describeError } from "../utils/describe-error.ts";

export interface RecoveryCatchUpTarget {
  channel: string;
  threadTs: string | null;
  oldest: string;
}

export interface RecoveryCatchUpResult {
  fed: number;
  failed: number;
}

export interface RecoverySlack {
  replay(event: StoredEvent): Promise<void>;
  catchUp(target: RecoveryCatchUpTarget): Promise<RecoveryCatchUpResult>;
}

export interface RecoveryLogger {
  error(message: string): void;
}

export interface RecoverySnapshotOptions {
  store: Pick<Store, "events" | "tasks" | "threads">;
  ownerUserId: string;
  channels: readonly string[];
  now?: () => number;
}

export interface RecoverySnapshot {
  unfinishedEvents: readonly StoredEvent[];
  runningTaskIds: readonly string[];
  catchUpTargets: readonly RecoveryCatchUpTarget[];
  conversationsWithoutHistory: readonly string[];
}

export interface RecoveryOptions {
  store: Pick<Store, "inputs" | "transaction">;
  slack: RecoverySlack;
  snapshot: RecoverySnapshot;
  logger: RecoveryLogger;
}

export interface RecoveryReport {
  replayedEvents: number;
  restartedTasks: number;
  caughtUpMessages: number;
  conversationsWithoutHistory: string[];
  failures: number;
}

export const RESTART_NOTE =
  "The superagent service restarted while you were working. Before repeating anything that reaches outside your worktree, such as a push, a pull request or a comment, check git status, your branch and its pull request for what already happened. Then pick up where you left off.";

const OPEN_TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "waiting",
  "ready",
];

const ENDED_TASK_STATES: readonly TaskState[] = [
  "done",
  "blocked",
  "failed",
  "stopped",
];

export const takeRecoverySnapshot = ({
  store,
  ownerUserId,
  channels,
  now = Date.now,
}: RecoverySnapshotOptions): RecoverySnapshot => {
  const conversations = [
    ...new Set([
      ...store.events.directMessageChannels(ownerUserId),
      ...channels,
    ]),
  ].map((channel) => ({
    channel,
    threadTs: null,
    oldest: store.events.latestTs(channel),
  }));
  const taskThreads = [
    ...store.threads.ownedByTasksIn(OPEN_TASK_STATES),
    ...store.threads.ownedByTasksIn(
      ENDED_TASK_STATES,
      now() - RECOVERY_ENDED_TASK_WINDOW_MS,
    ),
  ].map(({ channel, threadTs }) => ({
    channel,
    threadTs,
    oldest: store.events.latestTsInThread(channel, threadTs) ?? threadTs,
  }));
  return {
    unfinishedEvents: store.events.unfinished(),
    runningTaskIds: store.tasks.withState(["running"]).map(({ id }) => id),
    catchUpTargets: [...conversations, ...taskThreads].flatMap(
      ({ channel, threadTs, oldest }) =>
        oldest === undefined ? [] : [{ channel, threadTs, oldest }],
    ),
    conversationsWithoutHistory: conversations
      .filter(({ oldest }) => oldest === undefined)
      .map(({ channel }) => channel),
  };
};

export const recoverAfterRestart = async ({
  store,
  slack,
  snapshot,
  logger,
}: RecoveryOptions): Promise<RecoveryReport> => {
  const report: RecoveryReport = {
    replayedEvents: 0,
    restartedTasks: snapshot.runningTaskIds.length,
    caughtUpMessages: 0,
    conversationsWithoutHistory: [...snapshot.conversationsWithoutHistory],
    failures: 0,
  };

  for (const event of snapshot.unfinishedEvents) {
    try {
      await slack.replay(event);
      report.replayedEvents += 1;
    } catch (error) {
      report.failures += 1;
      logger.error(
        `recovery: replaying event ${event.eventId} failed: ${describeError(error)}`,
      );
    }
  }

  store.transaction(() => {
    for (const taskId of snapshot.runningTaskIds) {
      store.inputs.add({
        taskId,
        source: "system",
        ref: null,
        text: RESTART_NOTE,
      });
    }
  });

  for (const target of snapshot.catchUpTargets) {
    try {
      const result = await slack.catchUp(target);
      report.caughtUpMessages += result.fed;
      report.failures += result.failed;
    } catch (error) {
      report.failures += 1;
      logger.error(
        `recovery: catching up on ${target.threadTs === null ? target.channel : `${target.channel} thread ${target.threadTs}`} failed: ${describeError(error)}`,
      );
    }
  }

  return report;
};
