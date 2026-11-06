import { OUTBOX_POLL_INTERVAL_MS } from "../constants.ts";
import type { OutboxEntry, OutboxStore } from "../store/outbox.ts";
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
  findPost(query: OutboxPostQuery): Promise<string | undefined>;
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
  start(delivery: OutboxDelivery): void;
  wake(): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
}

export const createOutboxSender = ({
  outbox,
  logger,
  pollIntervalMs = OUTBOX_POLL_INTERVAL_MS,
}: OutboxSenderOptions): OutboxSender => {
  let activeDelivery: OutboxDelivery | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let drainInFlight: Promise<void> | undefined;
  let isAnotherDrainRequested = false;

  const sendEntry = async (
    delivery: OutboxDelivery,
    entry: OutboxEntry,
  ): Promise<void> => {
    const attempt = outbox.beginAttempt(entry.id);
    try {
      if (attempt.message.kind === "reaction") {
        await delivery.react({
          channel: attempt.channel,
          timestamp: attempt.message.timestamp,
          name: attempt.message.name,
        });
        outbox.markSent(attempt.id, null);
        return;
      }
      const target = {
        channel: attempt.channel,
        threadTs: attempt.threadTs,
        dedupeKey: attempt.dedupeKey,
      };
      const earlierPostTs =
        attempt.attempts > 1
          ? await delivery.findPost({
              ...target,
              postedAfter: attempt.createdAt,
            })
          : undefined;
      if (earlierPostTs !== undefined) {
        outbox.markSent(attempt.id, earlierPostTs);
        return;
      }
      if (activeDelivery === undefined) return;
      outbox.markSent(
        attempt.id,
        await delivery.post({ ...target, text: attempt.message.text }),
      );
    } catch (error) {
      const reason = describeError(error);
      const failure = delivery.classifyFailure(error);
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

  const sendDueEntries = async (delivery: OutboxDelivery): Promise<void> => {
    for (
      let dueEntries = outbox.pending();
      dueEntries.length > 0 && activeDelivery !== undefined;
      dueEntries = outbox.pending()
    ) {
      for (const entry of dueEntries) {
        if (activeDelivery === undefined) return;
        await sendEntry(delivery, entry);
      }
    }
  };

  const drain = (): Promise<void> => {
    const delivery = activeDelivery;
    if (delivery === undefined) return Promise.resolve();
    if (drainInFlight !== undefined) {
      isAnotherDrainRequested = true;
      return drainInFlight;
    }
    drainInFlight = (async () => {
      do {
        isAnotherDrainRequested = false;
        await sendDueEntries(delivery);
      } while (isAnotherDrainRequested && activeDelivery !== undefined);
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
    start: (delivery) => {
      if (activeDelivery !== undefined) {
        throw new Error("The outbox sender is already running.");
      }
      activeDelivery = delivery;
      pollTimer = setInterval(drainInBackground, pollIntervalMs);
      drainInBackground();
    },
    wake: drainInBackground,
    drain,
    stop: async () => {
      clearInterval(pollTimer);
      pollTimer = undefined;
      activeDelivery = undefined;
      await drainInFlight?.catch(() => undefined);
    },
  };
};
