import {
  TASK_FALLBACK_SUMMARY_MAX_LENGTH,
  TASK_MAX_SESSIONS,
  TASK_RUNNER_POLL_INTERVAL_MS,
} from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS, type Task } from "../store/tasks.ts";
import { describeError } from "../utils/describe-error.ts";
import { truncateText } from "../utils/truncate-text.ts";
import type {
  StartWorkerSession,
  WorkerSession,
  WorkerSessionEvents,
  WorkerTurn,
} from "./claude-session.ts";
import {
  type PrepareWorktree,
  prepareWorktree as prepareGitWorktree,
} from "./prepare-worktree.ts";
import {
  recordReport,
  type ReportOutcome,
  type WorkerReport,
} from "./record-report.ts";

export interface TaskRunnerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface TaskRunnerOptions {
  store: Pick<Store, "transaction" | "tasks" | "inputs" | "reports" | "outbox">;
  repos: ReadonlyMap<string, Repo>;
  worktreesDirectory: string;
  startSession: StartWorkerSession;
  wakeOutbox: () => void;
  logger: TaskRunnerLogger;
  prepareWorktree?: PrepareWorktree;
  maxSessions?: number;
  pollIntervalMs?: number;
}

export interface TaskRunner {
  start(): void;
  wake(): void;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

interface LiveSession {
  session: WorkerSession;
  isEnding: boolean;
}

const fallbackSummary = (text: string, whenEmpty: string): string =>
  truncateText(text.trim() || whenEmpty, TASK_FALLBACK_SUMMARY_MAX_LENGTH);

export const createTaskRunner = ({
  store,
  repos,
  worktreesDirectory,
  startSession,
  wakeOutbox,
  logger,
  prepareWorktree = prepareGitWorktree,
  maxSessions = TASK_MAX_SESSIONS,
  pollIntervalMs = TASK_RUNNER_POLL_INTERVAL_MS,
}: TaskRunnerOptions): TaskRunner => {
  const liveSessions = new Map<string, LiveSession>();
  const launchingTaskIds = new Set<string>();
  const launches = new Set<Promise<void>>();
  let isRunning = false;
  let pollTimer: NodeJS.Timeout | undefined;

  const report = (
    taskId: string,
    workerReport: WorkerReport,
  ): ReportOutcome => {
    const outcome = recordReport({ store, taskId, report: workerReport });
    if (outcome.isAccepted) wakeOutbox();
    return outcome;
  };

  const moveToRunning = (taskId: string): void => {
    const task = store.tasks.get(taskId);
    if (task === undefined || task.state === "running") return;
    if (TASK_TRANSITIONS[task.state].includes("running")) {
      store.tasks.transition(taskId, "running");
    }
  };

  const deliver = (taskId: string, live: LiveSession): void => {
    const inputs = store.inputs.undelivered(taskId);
    if (inputs.length === 0) return;
    store.transaction(() => {
      moveToRunning(taskId);
      store.inputs.markDelivered(inputs.map(({ id }) => id));
    });
    live.session.send(inputs);
  };

  const endTurn = (
    taskId: string,
    live: LiveSession,
    turn: WorkerTurn,
  ): void => {
    store.inputs.markRead(turn.readInputIds);
    if (!turn.isIdle || live.isEnding) return;
    if (store.inputs.undelivered(taskId).length > 0) {
      deliver(taskId, live);
      return;
    }
    report(
      taskId,
      turn.isError
        ? {
            state: "failed",
            summary: fallbackSummary(
              turn.resultText,
              "The worker's turn failed.",
            ),
          }
        : {
            state: "waiting",
            summary: fallbackSummary(
              turn.resultText,
              "The worker ended its turn without a report.",
            ),
            question: "How should I go on?",
          },
    );
    live.isEnding = true;
    live.session.end();
  };

  const endSession = (taskId: string, error: unknown): void => {
    liveSessions.delete(taskId);
    if (!isRunning) return;
    if (error !== undefined) {
      logger.error(
        `tasks: ${taskId}'s session failed: ${describeError(error)}`,
      );
    }
    report(taskId, {
      state: "failed",
      summary:
        error === undefined
          ? "The Claude Code session ended before the worker reported."
          : `The Claude Code session stopped: ${describeError(error)}`,
    });
    wake();
  };

  const sessionEvents = (
    taskId: string,
    currentLive: () => LiveSession | undefined,
  ): WorkerSessionEvents => {
    const guard =
      <Args extends unknown[]>(
        label: string,
        handle: (...args: Args) => void,
      ) =>
      (...args: Args): void => {
        try {
          handle(...args);
        } catch (error) {
          logger.error(
            `tasks: ${taskId} ${label} failed: ${describeError(error)}`,
          );
        }
      };
    return {
      onSessionId: guard("saving the session ID", (sessionId) => {
        store.tasks.update(taskId, { sessionId });
      }),
      onTurnEnd: guard("ending a turn", (turn) => {
        const live = currentLive();
        if (live === undefined) store.inputs.markRead(turn.readInputIds);
        else endTurn(taskId, live, turn);
      }),
      onEnd: guard("ending the session", (error) => {
        if (currentLive() !== undefined) endSession(taskId, error);
      }),
    };
  };

  const launch = async (task: Task): Promise<void> => {
    launchingTaskIds.add(task.id);
    try {
      moveToRunning(task.id);
      const repo = repos.get(task.repo);
      if (repo === undefined) {
        throw new Error(`the repo ${task.repo} isn't in the superagent config`);
      }
      const worktree = await prepareWorktree({
        repo,
        taskId: task.id,
        worktreesDirectory,
      });
      if (!isRunning || store.tasks.get(task.id)?.state !== "running") return;
      const runningTask = store.tasks.update(task.id, {
        branch: worktree.branch,
        worktree: worktree.path,
      });
      const inputs = store.inputs.unread(task.id);
      store.inputs.markDelivered(inputs.map(({ id }) => id));
      let live: LiveSession | undefined;
      const session = startSession({
        task: runningTask,
        repo,
        worktree,
        inputs,
        report: (workerReport) => report(task.id, workerReport),
        events: sessionEvents(task.id, () =>
          live !== undefined && liveSessions.get(task.id) === live
            ? live
            : undefined,
        ),
      });
      live = { session, isEnding: false };
      liveSessions.set(task.id, live);
      logger.info(
        `tasks: ${runningTask.sessionId === null ? "started" : "resumed"} ${task.id} in ${worktree.path}`,
      );
    } catch (error) {
      logger.error(`tasks: couldn't start ${task.id}: ${describeError(error)}`);
      store.inputs.markDelivered(
        store.inputs.undelivered(task.id).map(({ id }) => id),
      );
      report(task.id, {
        state: "failed",
        summary: `Couldn't start: ${describeError(error)}`,
      });
    } finally {
      launchingTaskIds.delete(task.id);
    }
  };

  const candidateTasks = (): Task[] => {
    const taskIds = new Set([
      ...store.tasks.withState(["queued", "running"]).map(({ id }) => id),
      ...store.inputs.tasksWithUndelivered(),
    ]);
    return [...taskIds]
      .map((taskId) => store.tasks.get(taskId))
      .filter((task) => task !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt);
  };

  const endStoppedSessions = (): void => {
    for (const [taskId, live] of liveSessions) {
      if (live.isEnding || store.tasks.get(taskId)?.state !== "stopped") {
        continue;
      }
      live.isEnding = true;
      live.session
        .interrupt()
        .catch((error: unknown) => {
          logger.error(
            `tasks: interrupting ${taskId} failed: ${describeError(error)}`,
          );
        })
        .finally(live.session.end);
    }
  };

  const reconcile = async (): Promise<void> => {
    if (!isRunning) return;
    endStoppedSessions();
    const startedLaunches: Promise<void>[] = [];
    for (const task of candidateTasks()) {
      const live = liveSessions.get(task.id);
      if (live !== undefined) {
        if (!live.isEnding) deliver(task.id, live);
        continue;
      }
      if (launchingTaskIds.has(task.id)) continue;
      if (store.inputs.unread(task.id).length === 0) continue;
      if (liveSessions.size + launchingTaskIds.size >= maxSessions) continue;
      const launched = launch(task).finally(() => launches.delete(launched));
      launches.add(launched);
      startedLaunches.push(launched);
    }
    await Promise.all(startedLaunches);
  };

  const wake = (): void => {
    reconcile().catch((error: unknown) => {
      logger.error(`tasks: ${describeError(error)}`);
    });
  };

  return {
    start: () => {
      if (isRunning) throw new Error("The task runner is already running.");
      isRunning = true;
      pollTimer = setInterval(wake, pollIntervalMs);
      wake();
    },
    wake,
    reconcile,
    stop: async () => {
      isRunning = false;
      clearInterval(pollTimer);
      pollTimer = undefined;
      await Promise.allSettled(launches);
      for (const live of liveSessions.values()) live.session.close();
      liveSessions.clear();
    },
  };
};
