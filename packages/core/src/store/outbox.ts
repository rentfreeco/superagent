import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  OUTBOX_BASE_RETRY_DELAY_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_RETRY_DELAY_MS,
} from "../constants.ts";

const outboxMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("post"), text: z.string() }),
  z.object({
    kind: z.literal("reaction"),
    name: z.string(),
    timestamp: z.string(),
  }),
]);

export type OutboxMessage = z.infer<typeof outboxMessageSchema>;

const outboxStatusSchema = z.enum(["pending", "sent", "failed"]);

const outboxRowSchema = z.object({
  id: z.number(),
  dedupeKey: z.string(),
  channel: z.string(),
  threadTs: z.string().nullable(),
  kind: z.string(),
  body: z.string(),
  status: outboxStatusSchema,
  attempts: z.number(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.number(),
  slackTs: z.string().nullable(),
  createdAt: z.number(),
  sentAt: z.number().nullable(),
});

export interface OutboxEntry extends Omit<
  z.infer<typeof outboxRowSchema>,
  "kind" | "body"
> {
  message: OutboxMessage;
}

export interface NewOutboxEntry {
  dedupeKey: string;
  channel: string;
  threadTs: string | null;
  message: OutboxMessage;
}

export interface OutboxStore {
  get(id: number): OutboxEntry | undefined;
  enqueue(entry: NewOutboxEntry): OutboxEntry | undefined;
  pending(): OutboxEntry[];
  beginAttempt(id: number): OutboxEntry;
  markSent(id: number, slackTs: string | null): void;
  markFailed(id: number, error: string, minimumDelayMs?: number): OutboxEntry;
  markUndeliverable(id: number, error: string): OutboxEntry;
}

const OUTBOX_COLUMNS =
  "id, dedupe_key as dedupeKey, channel, thread_ts as threadTs, kind, body, status, attempts, last_error as lastError, next_attempt_at as nextAttemptAt, slack_ts as slackTs, created_at as createdAt, sent_at as sentAt";

const toOutboxEntry = (row: unknown): OutboxEntry => {
  const { kind, body, ...entry } = outboxRowSchema.parse(row);
  return {
    ...entry,
    message: outboxMessageSchema.parse({ ...JSON.parse(body), kind }),
  };
};

export const createOutboxStore = (
  database: DatabaseSync,
  now: () => number,
): OutboxStore => {
  const selectEntry = database.prepare(
    `select ${OUTBOX_COLUMNS} from outbox where id = :id`,
  );
  const insertEntry = database.prepare(
    `insert into outbox (dedupe_key, channel, thread_ts, kind, body, next_attempt_at, created_at)
     values (:dedupeKey, :channel, :threadTs, :kind, :body, :now, :now)
     on conflict (dedupe_key) do nothing
     returning ${OUTBOX_COLUMNS}`,
  );
  const selectPending = database.prepare(
    `select ${OUTBOX_COLUMNS} from outbox
     where status = 'pending' and next_attempt_at <= :now
       and not exists (
         select 1 from outbox as earlier
         where earlier.status = 'pending'
           and earlier.channel = outbox.channel
           and earlier.thread_ts is outbox.thread_ts
           and earlier.id < outbox.id
       )
     order by id`,
  );
  const updateAttempt = database.prepare(
    `update outbox set attempts = attempts + 1
     where id = :id and status = 'pending'
     returning ${OUTBOX_COLUMNS}`,
  );
  const updateSent = database.prepare(
    `update outbox set status = 'sent', slack_ts = :slackTs, sent_at = :now
     where id = :id and status = 'pending'`,
  );
  const updateFailed = database.prepare(
    `update outbox set
       last_error = :error,
       status = case when attempts >= :maxAttempts then 'failed' else 'pending' end,
       next_attempt_at = :now + max(
         min(:baseDelay << max(attempts - 1, 0), :maxDelay),
         :minimumDelay
       )
     where id = :id and status = 'pending'
     returning ${OUTBOX_COLUMNS}`,
  );
  const updateUndeliverable = database.prepare(
    `update outbox set status = 'failed', last_error = :error
     where id = :id and status = 'pending'
     returning ${OUTBOX_COLUMNS}`,
  );

  const requireUpdated = (
    row: Record<string, unknown> | undefined,
    id: number,
  ): OutboxEntry => {
    if (row === undefined) throw new Error(`No pending outbox entry ${id}`);
    return toOutboxEntry(row);
  };

  return {
    get: (id) => {
      const row = selectEntry.get({ id });
      return row === undefined ? undefined : toOutboxEntry(row);
    },
    enqueue: ({ dedupeKey, channel, threadTs, message }) => {
      const { kind, ...body } = message;
      const row = insertEntry.get({
        dedupeKey,
        channel,
        threadTs,
        kind,
        body: JSON.stringify(body),
        now: now(),
      });
      return row === undefined ? undefined : toOutboxEntry(row);
    },
    pending: () => selectPending.all({ now: now() }).map(toOutboxEntry),
    beginAttempt: (id) => requireUpdated(updateAttempt.get({ id }), id),
    markSent: (id, slackTs) => {
      updateSent.run({ id, slackTs, now: now() });
    },
    markFailed: (id, error, minimumDelayMs = 0) =>
      requireUpdated(
        updateFailed.get({
          id,
          error,
          now: now(),
          maxAttempts: OUTBOX_MAX_ATTEMPTS,
          baseDelay: OUTBOX_BASE_RETRY_DELAY_MS,
          maxDelay: OUTBOX_MAX_RETRY_DELAY_MS,
          minimumDelay: minimumDelayMs,
        }),
        id,
      ),
    markUndeliverable: (id, error) =>
      requireUpdated(updateUndeliverable.get({ id, error }), id),
  };
};
