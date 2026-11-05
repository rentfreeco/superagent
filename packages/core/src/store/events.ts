import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const eventDispositionSchema = z.enum([
  "received",
  "duplicate_message",
  "dropped_self",
  "dropped_not_owner",
  "ignored",
  "replied",
  "routed",
  "task_input",
  "stopped_task",
]);

export type EventDisposition = z.infer<typeof eventDispositionSchema>;

const storedEventSchema = z.object({
  eventId: z.string(),
  type: z.string(),
  channel: z.string().nullable(),
  ts: z.string().nullable(),
  threadTs: z.string().nullable(),
  user: z.string().nullable(),
  text: z.string().nullable(),
  disposition: eventDispositionSchema,
  receivedAt: z.number(),
});

export interface StoredEvent extends z.infer<typeof storedEventSchema> {}

export interface NewEvent {
  eventId: string;
  type: string;
  channel: string | null;
  ts: string | null;
  threadTs: string | null;
  user: string | null;
  text: string | null;
}

export interface EventStore {
  get(eventId: string): StoredEvent | undefined;
  record(event: NewEvent): boolean;
  claimMessage(eventId: string): boolean;
  setDisposition(eventId: string, disposition: EventDisposition): void;
  unfinished(): StoredEvent[];
  latestTs(channel: string): string | undefined;
}

const EVENT_COLUMNS =
  "event_id as eventId, type, channel, ts, thread_ts as threadTs, user, text, disposition, received_at as receivedAt";

const latestTsSchema = z.object({ latestTs: z.string().nullable() });

export const createEventStore = (
  database: DatabaseSync,
  now: () => number,
): EventStore => {
  const selectEvent = database.prepare(
    `select ${EVENT_COLUMNS} from events where event_id = :eventId`,
  );
  const insertEvent = database.prepare(
    `insert into events (event_id, type, channel, ts, thread_ts, user, text, received_at)
     values (:eventId, :type, :channel, :ts, :threadTs, :user, :text, :receivedAt)
     on conflict (event_id) do nothing`,
  );
  const claimMessage = database.prepare(
    `update or ignore events set message_claimed = 1
     where event_id = :eventId and channel is not null and ts is not null`,
  );
  const updateDisposition = database.prepare(
    `update events set
       disposition = :disposition,
       text = case when :disposition in ('dropped_self', 'dropped_not_owner') then null else text end
     where event_id = :eventId`,
  );
  const selectUnfinished = database.prepare(
    `select ${EVENT_COLUMNS} from events
     where disposition = 'received' order by received_at, event_id`,
  );
  const selectLatestTs = database.prepare(
    `select max(ts) as latestTs from events
     where channel = :channel and type in ('message', 'app_mention')`,
  );

  return {
    get: (eventId) => {
      const row = selectEvent.get({ eventId });
      return row === undefined ? undefined : storedEventSchema.parse(row);
    },
    record: (event) =>
      Number(
        insertEvent.run({
          eventId: event.eventId,
          type: event.type,
          channel: event.channel,
          ts: event.ts,
          threadTs: event.threadTs,
          user: event.user,
          text: event.text,
          receivedAt: now(),
        }).changes,
      ) > 0,
    claimMessage: (eventId) =>
      Number(claimMessage.run({ eventId }).changes) > 0,
    setDisposition: (eventId, disposition) => {
      updateDisposition.run({ eventId, disposition });
    },
    unfinished: () =>
      selectUnfinished.all().map((row) => storedEventSchema.parse(row)),
    latestTs: (channel) =>
      latestTsSchema.parse(selectLatestTs.get({ channel })).latestTs ??
      undefined,
  };
};
