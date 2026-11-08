import { OUTBOX_POLL_INTERVAL_MS } from "../constants.ts";
import type {
  GitHubSubject,
  OutboxEntry,
  OutboxStore,
} from "../store/outbox.ts";
import { describeError } from "../utils/describe-error.ts";

export interface OutboxPost {
  channel: string;
  threadTs: string | null;
  text: string;
  dedupeKey: string;
}

export interface OutboxReaction {
  channel: string;
  timestamp: string;
  name: string;
}

export interface OutboxPostQuery {
  channel: string;
  threadTs: string | null;
  dedupeKey: string;
  postedAfter: number;
}

export interface PermanentOutboxFailure {
  kind: "permanent";
}

export interface TransientOutboxFailure {
  kind: "transient";
  retryAfterMs?: number;
}

export type OutboxFailure = PermanentOutboxFailure | TransientOutboxFailure;

export interface OutboxDelivery {
  post(post: OutboxPost): Promise<string>;
  react(reaction: OutboxReaction): Promise<void>;
  /** Removes the bot's reaction; one that's already gone counts as removed. */
  unreact(reaction: OutboxReaction): Promise<void>;
  findPost(query: OutboxPostQuery): Promise<string | undefined>;
  classifyFailure(error: unknown): OutboxFailure;
}

export interface GitHubComment {
  /** owner/name */
  repository: string;
  issueNumber: number;
  text: string;
  dedupeKey: string;
}

export interface GitHubCommentQuery {
  repository: string;
  issueNumber: number;
  dedupeKey: string;
  postedAfter: number;
}

export interface GitHubReaction {
  repository: string;
  subject: GitHubSubject;
  subjectId: number;
  content: string;
}

/** What the sender needs to deliver GitHub entries, as the agent's account. */
export interface OutboxGitHubDelivery {
  comment(comment: GitHubComment): Promise<void>;
  /** Whether an earlier attempt already posted this comment. */
  hasComment(query: GitHubCommentQuery): Promise<boolean>;
  react(reaction: GitHubReaction): Promise<void>;
  /** Removes the agent's own reaction; one that's already gone counts as removed. */
  unreact(reaction: GitHubReaction): Promise<void>;
  classifyFailure(error: unknown): OutboxFailure;
}

export interface OutboxLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface OutboxSenderOptions {
  outbox: Pick<
    OutboxStore,
    "pending" | "beginAttempt" | "markSent" | "markFailed" | "markUndeliverable"
  >;
  logger: OutboxLogger;
  pollIntervalMs?: number;
}

export interface OutboxSender {
  /** Without a GitHub delivery, GitHub entries are given up on. */
  start(delivery: OutboxDelivery, gitHubDelivery?: OutboxGitHubDelivery): void;
  wake(): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

interface Deliveries {
  slack: OutboxDelivery;
  gitHub: OutboxGitHubDelivery | undefined;
}

const NO_GITHUB_DELIVERY = "no GitHub account to deliver it with";

export const createOutboxSender = ({
  outbox,
  logger,
  pollIntervalMs = OUTBOX_POLL_INTERVAL_MS,
}: OutboxSenderOptions): OutboxSender => {
  let activeDeliveries: Deliveries | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let drainInFlight: Promise<void> | undefined;
  let isAnotherDrainRequested = false;

  const deliverSlackPost = async (
    slack: OutboxDelivery,
    attempt: OutboxEntry,
    text: string,
  ): Promise<void> => {
    const target = {
      channel: attempt.channel,
      threadTs: attempt.threadTs,
      dedupeKey: attempt.dedupeKey,
    };
    const earlierPostTs =
      attempt.attempts > 1
        ? await slack.findPost({ ...target, postedAfter: attempt.createdAt })
        : undefined;
    if (earlierPostTs !== undefined) {
      outbox.markSent(attempt.id, earlierPostTs);
      return;
    }
    if (activeDeliveries === undefined) return;
    outbox.markSent(attempt.id, await slack.post({ ...target, text }));
  };

  const deliver = async (
    { slack, gitHub }: Deliveries,
    attempt: OutboxEntry,
  ): Promise<void> => {
    const { message } = attempt;
    switch (message.kind) {
      case "post":
        await deliverSlackPost(slack, attempt, message.text);
        return;
      case "reaction":
      case "reaction_removal": {
        const reaction = {
          channel: attempt.channel,
          timestamp: message.timestamp,
          name: message.name,
        };
        await (message.kind === "reaction"
          ? slack.react(reaction)
          : slack.unreact(reaction));
        outbox.markSent(attempt.id, null);
        return;
      }
      case "github_comment": {
        if (gitHub === undefined) throw new Error(NO_GITHUB_DELIVERY);
        const target = {
          repository: message.repository,
          issueNumber: message.issueNumber,
          dedupeKey: attempt.dedupeKey,
        };
        const isPosted =
          attempt.attempts > 1 &&
          (await gitHub.hasComment({
            ...target,
            postedAfter: attempt.createdAt,
          }));
        if (!isPosted) {
          if (activeDeliveries === undefined) return;
          await gitHub.comment({ ...target, text: message.text });
        }
        outbox.markSent(attempt.id, null);
        return;
      }
      case "github_reaction":
      case "github_reaction_removal": {
        if (gitHub === undefined) throw new Error(NO_GITHUB_DELIVERY);
        const { kind, ...reaction } = message;
        await (kind === "github_reaction"
          ? gitHub.react(reaction)
          : gitHub.unreact(reaction));
        outbox.markSent(attempt.id, null);
        return;
      }
    }
  };

  const sendEntry = async (
    deliveries: Deliveries,
    entry: OutboxEntry,
  ): Promise<void> => {
    const attempt = outbox.beginAttempt(entry.id);
    const isGitHub = attempt.message.kind.startsWith("github_");
    try {
      await deliver(deliveries, attempt);
    } catch (error) {
      const reason = describeError(error);
      const classifier = isGitHub ? deliveries.gitHub : deliveries.slack;
      const failure: OutboxFailure =
        classifier === undefined
          ? { kind: "permanent" }
          : classifier.classifyFailure(error);
      if (failure.kind === "permanent") {
        outbox.markUndeliverable(attempt.id, reason);
        logger.error(`outbox: gave up on ${attempt.dedupeKey}: ${reason}`);
        return;
      }
      const retry = outbox.markFailed(attempt.id, reason, failure.retryAfterMs);
      if (retry.status === "failed") {
        logger.error(
          `outbox: gave up on ${attempt.dedupeKey} after ${retry.attempts} attempts: ${reason}`,
        );
      } else {
        logger.warn(
          `outbox: ${attempt.dedupeKey} failed (${reason}); retrying at ${new Date(retry.nextAttemptAt).toISOString()}`,
        );
      }
    }
  };

  const sendDueEntries = async (deliveries: Deliveries): Promise<void> => {
    for (
      let dueEntries = outbox.pending();
      dueEntries.length > 0 && activeDeliveries !== undefined;
      dueEntries = outbox.pending()
    ) {
      for (const entry of dueEntries) {
        if (activeDeliveries === undefined) return;
        await sendEntry(deliveries, entry);
      }
    }
  };

  const drain = (): Promise<void> => {
    const deliveries = activeDeliveries;
    if (deliveries === undefined) return Promise.resolve();
    if (drainInFlight !== undefined) {
      isAnotherDrainRequested = true;
      return drainInFlight;
    }
    drainInFlight = (async () => {
      do {
        isAnotherDrainRequested = false;
        await sendDueEntries(deliveries);
      } while (isAnotherDrainRequested && activeDeliveries !== undefined);
    })().finally(() => {
      drainInFlight = undefined;
    });
    return drainInFlight;
  };

  const drainInBackground = (): void => {
    drain().catch((error: unknown) => {
      logger.error(`outbox: delivery stopped: ${describeError(error)}`);
    });
  };

  return {
    start: (delivery, gitHubDelivery) => {
      if (activeDeliveries !== undefined) {
        throw new Error("The outbox sender is already running.");
      }
      activeDeliveries = { slack: delivery, gitHub: gitHubDelivery };
      pollTimer = setInterval(drainInBackground, pollIntervalMs);
      drainInBackground();
    },
    wake: drainInBackground,
    drain,
    stop: async () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
      activeDeliveries = undefined;
      await drainInFlight?.catch(() => undefined);
    },
  };
};
