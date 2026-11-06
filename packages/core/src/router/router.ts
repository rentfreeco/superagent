import { z } from "zod";
import {
  ROUTER_DECISION_TIMEOUT_MS,
  ROUTER_POLL_INTERVAL_MS,
} from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { Candidate } from "../store/candidates.ts";
import type { Store } from "../store/open-store.ts";
import type { AgentSessionEvents } from "../tasks/agent-session.ts";
import type { ToolOutcome } from "../tasks/tool-outcome.ts";
import { describeError } from "../utils/describe-error.ts";
import {
  type DecisionContext,
  decideAttach,
  decideIgnore,
  decideReply,
  decideStartTask,
  decideStop,
} from "./decide.ts";
import { decideByChannelMap } from "./decide-by-channel-map.ts";
import { listTasks } from "./list-tasks.ts";
import type { RouterSession, StartRouterSession } from "./router-session.ts";
import type { RouterActions } from "./router-tools.ts";

export interface RouterLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface RouterOptions {
  store: DecisionContext["store"] & Pick<Store, "kv">;
  /** Repo name -> Repo. */
  repos: ReadonlyMap<string, Repo>;
  /** Channel ID -> Repo, for the fallback. */
  channelRepos: ReadonlyMap<string, Repo>;
  /** Without one, the channel map decides every candidate as soon as it's queued. */
  startSession?: StartRouterSession | undefined;
  wakeOutbox: () => void;
  wakeTaskRunner: () => void;
  logger: RouterLogger;
  now?: () => number;
  pollIntervalMs?: number;
  decisionTimeoutMs?: number;
}

export interface Router {
  start(): void;
  wake(): void;
  stop(): void;
}

interface LiveRouter {
  session: RouterSession;
  isEnding: boolean;
}

export const ROUTER_SESSION_KEY = "router.session_id";

export const createRouter = ({
  store,
  repos,
  channelRepos,
  startSession,
  wakeOutbox,
  wakeTaskRunner,
  logger,
  now = Date.now,
  pollIntervalMs = ROUTER_POLL_INTERVAL_MS,
  decisionTimeoutMs = ROUTER_DECISION_TIMEOUT_MS,
}: RouterOptions): Router => {
  const decisionContext: DecisionContext = {
    store,
    repos,
    decidedBy: "router",
  };
  let live: LiveRouter | undefined;
  let isRunning = false;
  let pollTimer: NodeJS.Timeout | undefined;

  const wakeWorkers = (): void => {
    wakeOutbox();
    wakeTaskRunner();
  };

  const decided = (outcome: ToolOutcome): ToolOutcome => {
    if (outcome.isAccepted) wakeWorkers();
    return outcome;
  };

  const actions: RouterActions = {
    startTask: (decision) =>
      decided(decideStartTask(decisionContext, decision)),
    reply: (decision) => decided(decideReply(decisionContext, decision)),
    attach: (decision) => decided(decideAttach(decisionContext, decision)),
    stop: (decision) => decided(decideStop(decisionContext, decision)),
    ignore: (decision) => decided(decideIgnore(decisionContext, decision)),
    listTasks: (which) => listTasks(store, which),
  };

  const fallBack = (candidates: readonly Candidate[]): void => {
    for (const candidate of candidates) {
      const outcome = decideByChannelMap(
        { store, repos, channelRepos },
        candidate,
      );
      if (outcome.isAccepted) {
        logger.info(
          `router: the channel map decided candidate ${candidate.id}`,
        );
      }
    }
    if (candidates.length > 0) wakeWorkers();
  };

  const deliveredUndecided = (): Candidate[] =>
    store.candidates
      .undecided()
      .filter((candidate) => candidate.deliveredAt !== null);

  const guarded =
    <Args extends unknown[]>(label: string, handle: (...args: Args) => void) =>
    (...args: Args): void => {
      try {
        handle(...args);
      } catch (error) {
        logger.error(`router: ${label} failed: ${describeError(error)}`);
      }
    };

  const sessionEvents = (isCurrent: () => boolean): AgentSessionEvents => ({
    onSessionId: guarded("saving the session ID", (sessionId) => {
      store.kv.set(ROUTER_SESSION_KEY, sessionId);
    }),
    onTurnEnd: guarded("ending a turn", (turn) => {
      if (!isCurrent() || live === undefined || !turn.isIdle) return;
      fallBack(deliveredUndecided());
      live.isEnding = true;
      live.session.end();
    }),
    onEnd: guarded("ending the session", (error) => {
      if (!isCurrent()) return;
      live = undefined;
      if (!isRunning) return;
      if (error !== undefined) {
        logger.error(`router: the session failed: ${describeError(error)}`);
      }
      fallBack(deliveredUndecided());
      wake();
    }),
  });

  const expireOverdue = (): void => {
    const overdue = deliveredUndecided().filter(
      ({ deliveredAt }) =>
        deliveredAt !== null && now() - deliveredAt > decisionTimeoutMs,
    );
    if (overdue.length === 0) return;
    logger.error(
      `router: ${overdue.length} candidate(s) waited over ${decisionTimeoutMs} ms for a decision`,
    );
    fallBack(overdue);
    if (live !== undefined) {
      live.isEnding = true;
      live.session.close();
    }
  };

  const launch = (
    startRouterSession: StartRouterSession,
    candidates: readonly Candidate[],
  ): void => {
    store.candidates.markDelivered(candidates.map(({ id }) => id));
    let current: LiveRouter | undefined;
    try {
      const session = startRouterSession({
        sessionId: store.kv.get(ROUTER_SESSION_KEY, z.string()) ?? null,
        candidates,
        actions,
        events: sessionEvents(() => current !== undefined && live === current),
      });
      current = { session, isEnding: false };
      live = current;
    } catch (error) {
      logger.error(`router: couldn't start: ${describeError(error)}`);
      fallBack(candidates);
    }
  };

  const reconcile = (): void => {
    if (!isRunning) return;
    if (startSession === undefined) {
      fallBack(store.candidates.undecided());
      return;
    }
    expireOverdue();
    if (live !== undefined) {
      if (live.isEnding) return;
      const undelivered = store.candidates.undelivered();
      if (undelivered.length === 0) return;
      store.candidates.markDelivered(undelivered.map(({ id }) => id));
      live.session.send(undelivered);
      return;
    }
    const waiting = store.candidates.undecided();
    if (waiting.length > 0) launch(startSession, waiting);
  };

  const wake = guarded("routing", reconcile);

  return {
    start: () => {
      if (isRunning) throw new Error("The router is already running.");
      isRunning = true;
      pollTimer = setInterval(wake, pollIntervalMs);
      wake();
    },
    wake,
    stop: () => {
      isRunning = false;
      clearInterval(pollTimer);
      pollTimer = undefined;
      live?.session.close();
      live = undefined;
    },
  };
};
