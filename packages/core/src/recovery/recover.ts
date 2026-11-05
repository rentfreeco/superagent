import type { StoredEvent } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import type { TaskState } from "../store/tasks.ts";

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

export interface RecoveryOptions {
  store: Pick<Store, "events" | "tasks" | "inputs" | "threads" | "transaction">;
  slack: RecoverySlack;
  unfinishedEvents: readonly StoredEvent[];
  ownerUserId: string;
  channels: readonly string[];
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
  "The superagent service restarted while you were working. Pick up where you left off.";

const OPEN_TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "waiting",
  "ready",
];

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const recoverAfterRestart = async ({
  store,
  slack,
  unfinishedEvents,
  ownerUserId,
  channels,
  logger,
}: RecoveryOptions): Promise<RecoveryReport> => {
  const report: RecoveryReport = {
    replayedEvents: 0,
    restartedTasks: 0,
    caughtUpMessages: 0,
    conversationsWithoutHistory: [],
    failures: 0,
  };

  for (const event of unfinishedEvents) {
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

  const runningTasks = store.tasks.withState(["running"]);
  store.transaction(() => {
    for (const task of runningTasks) {
      store.inputs.add({
        taskId: task.id,
        source: "system",
        ref: null,
        text: RESTART_NOTE,
      });
    }
  });
  report.restartedTasks = runningTasks.length;

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
  const taskThreads = store.threads
    .ownedByTasksIn(OPEN_TASK_STATES)
    .map(({ channel, threadTs }) => ({
      channel,
      threadTs,
      oldest: store.events.latestTsInThread(channel, threadTs) ?? threadTs,
    }));

  for (const { channel, threadTs, oldest } of [
    ...conversations,
    ...taskThreads,
  ]) {
    if (oldest === undefined) {
      report.conversationsWithoutHistory.push(channel);
      continue;
    }
    try {
      const result = await slack.catchUp({ channel, threadTs, oldest });
      report.caughtUpMessages += result.fed;
      report.failures += result.failed;
    } catch (error) {
      report.failures += 1;
      logger.error(
        `recovery: catching up on ${threadTs === null ? channel : `${channel} thread ${threadTs}`} failed: ${describeError(error)}`,
      );
    }
  }

  return report;
};
