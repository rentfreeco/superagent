import {
  TASK_FALLBACK_SUMMARY_MAX_LENGTH,
  TASK_MAX_SESSIONS,
  TASK_RUNNER_POLL_INTERVAL_MS,
} from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS, type Task, type TaskState } from "../store/tasks.ts";
import { describeError } from "../utils/describe-error.ts";
import { truncateText } from "../utils/truncate-text.ts";
import { acknowledgeMessages } from "./acknowledge-messages.ts";
import { finishAcknowledgements } from "./finish-acknowledgements.ts";
import type { TaskPullRequest } from "./message-reactions.ts";
import { handBackMessage } from "./hand-back-message.ts";
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
  type ReportDestinations,
  recordReport,
  REPORT_STATES,
  type WorkerReport,
} from "./record-report.ts";
import { readTaskThread, type ThreadReader } from "./read-task-thread.ts";
import type { ToolOutcome } from "./tool-outcome.ts";

export interface TaskRunnerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface TaskRunnerOptions {
  store: Pick<
    Store,
    | "transaction"
    | "tasks"
    | "inputs"
    | "reports"
    | "outbox"
    | "events"
    | "candidates"
  >;
  repos: ReadonlyMap<string, Repo>;
  worktreesDirectory: string;
  startSession: StartWorkerSession;
  wakeOutbox: () => void;
  /** Called after a worker hands a message back, for the router to decide. */
  wakeRouter: () => void;
  logger: TaskRunnerLogger;
  ownerUserId: string;
  prepareWorktree?: PrepareWorktree;
  maxSessions?: number;
  pollIntervalMs?: number;
}

export interface TaskRunner {
  start(threads: ThreadReader): void;
  wake(): void;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

interface LiveSession {
  session: WorkerSession;
  isEnding: boolean;
  /** Whether the worker handed a message back during the current turn. */
  hasHandedBackThisTurn: boolean;
  /** Whether the worker said the current turn has nothing to report. */
  hasNothingToReport: boolean;
  /** Inputs this session was given since the worker's last accepted report, for where the next one goes. */
  deliveredSinceReport: Set<number>;
  /** Inputs the worker handed back, which the router answers instead. */
  handedBackInputIds: Set<number>;
}

const isReportedState = (state: TaskState): boolean =>
  REPORT_STATES.some((reportState) => reportState === state);

const describeAcknowledgement = (acknowledgedCount: number): string => {
  if (acknowledgedCount === 0) return "There's no new message to acknowledge.";
  return acknowledgedCount === 1
    ? "Put 👀 on the message."
    : `Put 👀 on ${acknowledgedCount} messages.`;
};

const fallbackSummary = (text: string, whenEmpty: string): string =>
  truncateText(text.trim() || whenEmpty, TASK_FALLBACK_SUMMARY_MAX_LENGTH);

export const createTaskRunner = ({
  store,
  repos,
  worktreesDirectory,
  startSession,
  wakeOutbox,
  wakeRouter,
  logger,
  ownerUserId,
  prepareWorktree = prepareGitWorktree,
  maxSessions = TASK_MAX_SESSIONS,
  pollIntervalMs = TASK_RUNNER_POLL_INTERVAL_MS,
}: TaskRunnerOptions): TaskRunner => {
  const liveSessions = new Map<string, LiveSession>();
  const launchingTaskIds = new Set<string>();
  const launches = new Set<Promise<void>>();
  let isRunning = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let threadReader: ThreadReader | undefined;

  const moveToRunning = (taskId: string): void => {
    const task = store.tasks.get(taskId);
    if (task === undefined || task.state === "running") return;
    if (TASK_TRANSITIONS[task.state].includes("running")) {
      store.tasks.transition(taskId, "running");
    }
  };

  /** Its pull request closed it, so no session reopens it; the owner's next message does, through a launch. */
  const isClosed = (taskId: string): boolean =>
    (store.tasks.get(taskId)?.closedAt ?? null) !== null;

  const reopenReportedTask = (taskId: string): void => {
    const task = store.tasks.get(taskId);
    if (
      task !== undefined &&
      task.closedAt === null &&
      isReportedState(task.state)
    ) {
      store.tasks.transition(taskId, "running");
    }
  };

  const restoreReportedState = (taskId: string): boolean => {
    const latestReport = store.reports.latest(taskId);
    if (
      store.tasks.get(taskId)?.state !== "running" ||
      latestReport === undefined
    ) {
      return false;
    }
    store.tasks.transition(taskId, latestReport.state);
    return true;
  };

  const repositoryOf = (taskId: string): string | undefined =>
    repos.get(store.tasks.get(taskId)?.repo ?? "")?.github;

  const pullRequestOf = (taskId: string): TaskPullRequest | undefined => {
    const repository = repositoryOf(taskId);
    const number = store.tasks.get(taskId)?.prNumber;
    return repository === undefined || number === null || number === undefined
      ? undefined
      : { repository, number };
  };

  const acknowledge = async (taskId: string): Promise<string> => {
    const acknowledgedCount = acknowledgeMessages({
      store,
      taskId,
      pullRequest: pullRequestOf(taskId),
    });
    if (acknowledgedCount > 0) wakeOutbox();
    return describeAcknowledgement(acknowledgedCount);
  };

  /** Slack for Slack messages, the pull request for GitHub ones, Slack when there were neither. */
  const reportDestinations = (
    taskId: string,
    inputIds: Iterable<number>,
  ): ReportDestinations => {
    const sources = new Set(
      [...inputIds].map((inputId) => store.inputs.get(inputId)?.source),
    );
    const isFromSlack = sources.has("slack") || sources.has("router");
    const pullRequest = sources.has("github")
      ? pullRequestOf(taskId)
      : undefined;
    return { slack: isFromSlack || pullRequest === undefined, pullRequest };
  };

  const handBack = (
    taskId: string,
    inputId: number,
    reason: string,
  ): ToolOutcome => {
    const outcome = handBackMessage({ store, taskId, inputId, reason });
    if (!outcome.isAccepted) return outcome;
    const live = liveSessions.get(taskId);
    if (live !== undefined) {
      live.hasHandedBackThisTurn = true;
      live.handedBackInputIds.add(inputId);
      live.deliveredSinceReport.delete(inputId);
    }
    wakeRouter();
    return outcome;
  };

  const nothingToReport = (taskId: string): ToolOutcome => {
    const live = liveSessions.get(taskId);
    if (!live?.hasHandedBackThisTurn) {
      return {
        isAccepted: false,
        reply:
          "Use nothing_to_report only in a turn where you handed a message back. Otherwise report where the task stands.",
      };
    }
    const latestReport = store.reports.latest(taskId);
    if (latestReport === undefined) {
      return {
        isAccepted: false,
        reply:
          "This task hasn't reported yet, so there's nothing to go back to. Report where it stands.",
      };
    }
    live.hasNothingToReport = true;
    return {
      isAccepted: true,
      reply: `The task stays ${latestReport.state}, and nothing is posted. End your turn.`,
    };
  };

  const settleReport = (outcome: ToolOutcome): ToolOutcome => {
    if (outcome.isAccepted) wakeOutbox();
    return outcome;
  };

  const postReport = (
    taskId: string,
    workerReport: WorkerReport,
    destinations?: ReportDestinations,
  ): ToolOutcome =>
    settleReport(
      recordReport({
        store,
        taskId,
        report: workerReport,
        repository: repositoryOf(taskId),
        destinations,
      }),
    );

  const postWorkerReport = (
    taskId: string,
    workerReport: WorkerReport,
  ): ToolOutcome => {
    const live = liveSessions.get(taskId);
    const outcome = settleReport(
      store.transaction(() => {
        reopenReportedTask(taskId);
        return recordReport({
          store,
          taskId,
          report: workerReport,
          repository: repositoryOf(taskId),
          destinations: reportDestinations(
            taskId,
            live?.deliveredSinceReport ?? [],
          ),
        });
      }),
    );
    if (outcome.isAccepted) live?.deliveredSinceReport.clear();
    return outcome;
  };

  const deliver = (taskId: string, live: LiveSession): void => {
    const inputs = store.inputs.undelivered(taskId);
    if (inputs.length === 0) return;
    store.transaction(() => {
      reopenReportedTask(taskId);
      store.inputs.markDelivered(inputs.map(({ id }) => id));
    });
    for (const { id } of inputs) live.deliveredSinceReport.add(id);
    live.session.send(inputs);
  };

  const endTurn = (
    taskId: string,
    live: LiveSession,
    turn: WorkerTurn,
  ): void => {
    store.inputs.markRead(turn.readInputIds);
    if (live.isEnding) return;
    if (!turn.isError) {
      const finishedCount = finishAcknowledgements({
        store,
        inputIds: turn.readInputIds.filter(
          (inputId) => !live.handedBackInputIds.has(inputId),
        ),
        pullRequest: pullRequestOf(taskId),
      });
      if (finishedCount > 0) wakeOutbox();
    }
    const { hasNothingToReport } = live;
    live.hasHandedBackThisTurn = false;
    live.hasNothingToReport = false;
    if (!turn.isIdle) {
      reopenReportedTask(taskId);
      return;
    }
    if (store.inputs.undelivered(taskId).length > 0) {
      deliver(taskId, live);
      return;
    }
    if (!turn.isError && hasNothingToReport && restoreReportedState(taskId)) {
      live.isEnding = true;
      live.session.end();
      return;
    }
    if (turn.isError) {
      postReport(taskId, {
        state: "failed",
        summary: fallbackSummary(turn.resultText, "The worker's turn failed."),
      });
    } else {
      postReport(
        taskId,
        {
          state: "waiting",
          summary: fallbackSummary(
            turn.resultText,
            "The worker ended its turn without a report.",
          ),
          question: "How should I go on?",
        },
        reportDestinations(taskId, live.deliveredSinceReport),
      );
    }
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
    postReport(taskId, {
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
      const threads = threadReader;
      if (
        !isRunning ||
        threads === undefined ||
        store.tasks.get(task.id)?.state !== "running"
      ) {
        return;
      }
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
        ack: () => acknowledge(task.id),
        readThread: () =>
          readTaskThread({ threads, task: runningTask, ownerUserId }),
        report: (workerReport) => postWorkerReport(task.id, workerReport),
        handBack: (inputId, reason) => handBack(task.id, inputId, reason),
        nothingToReport: () => nothingToReport(task.id),
        pullRequest: () => pullRequestOf(task.id),
        events: sessionEvents(task.id, () =>
          live !== undefined && liveSessions.get(task.id) === live
            ? live
            : undefined,
        ),
      });
      live = {
        session,
        isEnding: false,
        hasHandedBackThisTurn: false,
        hasNothingToReport: false,
        deliveredSinceReport: new Set(inputs.map(({ id }) => id)),
        handedBackInputIds: new Set(),
      };
      liveSessions.set(task.id, live);
      logger.info(
        `tasks: ${runningTask.sessionId === null ? "started" : "resumed"} ${task.id} in ${worktree.path}`,
      );
    } catch (error) {
      logger.error(`tasks: couldn't start ${task.id}: ${describeError(error)}`);
      store.inputs.markDelivered(
        store.inputs.undelivered(task.id).map(({ id }) => id),
      );
      postReport(task.id, {
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

  const endStoppedAndClosedSessions = (): void => {
    for (const [taskId, live] of liveSessions) {
      const isStopped = store.tasks.get(taskId)?.state === "stopped";
      if (live.isEnding || !(isStopped || isClosed(taskId))) {
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
    endStoppedAndClosedSessions();
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
    start: (threads) => {
      if (isRunning) throw new Error("The task runner is already running.");
      isRunning = true;
      threadReader = threads;
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
