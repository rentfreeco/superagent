import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Transaction } from "./transaction.ts";

export const MIGRATIONS: readonly string[] = [
  `
  create table events (
    event_id text primary key,
    type text not null,
    channel text,
    ts text,
    thread_ts text,
    user text,
    text text,
    disposition text not null default 'received' check (disposition in (
      'received', 'duplicate_message', 'dropped_self', 'dropped_not_owner',
      'ignored', 'replied', 'routed', 'task_input', 'stopped_task'
    )),
    message_claimed integer not null default 0 check (message_claimed in (0, 1)),
    received_at integer not null
  );
  create index events_by_channel on events (channel, ts);
  create unique index events_one_claim_per_message on events (channel, ts)
    where message_claimed = 1;
  create index events_unfinished on events (received_at)
    where disposition = 'received';

  create table tasks (
    id text primary key,
    title text not null,
    repo text not null,
    state text not null check (state in (
      'queued', 'running', 'waiting', 'ready',
      'done', 'blocked', 'failed', 'stopped'
    )),
    branch text,
    worktree text,
    pr_number integer,
    session_id text,
    origin_channel text not null,
    origin_ts text not null,
    created_at integer not null,
    last_activity_at integer not null
  );
  create index tasks_by_state on tasks (state);

  create table threads (
    channel text not null,
    thread_ts text not null,
    task_id text references tasks (id),
    created_at integer not null,
    primary key (channel, thread_ts)
  );
  create index threads_by_task on threads (task_id);

  create table inputs (
    id integer primary key,
    task_id text not null references tasks (id),
    source text not null check (source in ('slack', 'github', 'router', 'system')),
    ref text,
    text text not null,
    created_at integer not null,
    delivered_at integer,
    read_at integer,
    unique (source, ref)
  );
  create index inputs_undelivered on inputs (task_id)
    where delivered_at is null;

  create table reports (
    id integer primary key,
    task_id text not null references tasks (id),
    state text not null check (state in (
      'queued', 'running', 'waiting', 'ready',
      'done', 'blocked', 'failed', 'stopped'
    )),
    summary text,
    question text,
    created_at integer not null
  );
  create index reports_by_task on reports (task_id, id);

  create table outbox (
    id integer primary key,
    dedupe_key text not null unique,
    channel text not null,
    thread_ts text,
    kind text not null check (kind in ('post', 'reaction')),
    body text not null,
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
    attempts integer not null default 0,
    last_error text,
    next_attempt_at integer not null,
    slack_ts text,
    created_at integer not null,
    sent_at integer
  );
  create index outbox_pending on outbox (next_attempt_at)
    where status = 'pending';

  create table kv (
    key text primary key,
    value text not null,
    updated_at integer not null
  );
  `,
  `
  create table candidates (
    id integer primary key,
    event_id text not null references events (event_id),
    channel text not null,
    ts text not null,
    thread_ts text not null,
    user text not null,
    text text not null,
    via text not null check (via in ('dm', 'mention', 'thread')),
    handed_back_by text references tasks (id),
    hand_back_reason text,
    created_at integer not null,
    delivered_at integer,
    decided_at integer
  );
  create unique index candidates_once on candidates (event_id, coalesce(handed_back_by, ''));
  create index candidates_undecided on candidates (id) where decided_at is null;

  create table decisions (
    id integer primary key,
    candidate_id integer not null references candidates (id),
    outcome text not null check (outcome in ('start_task', 'reply', 'attach', 'stop', 'ignore')),
    task_id text references tasks (id),
    reason text not null,
    decided_by text not null check (decided_by in ('router', 'fallback')),
    created_at integer not null
  );
  create unique index decisions_once on decisions (candidate_id);
  `,
  `
  create table outbox_rebuilt (
    id integer primary key,
    dedupe_key text not null unique,
    channel text not null,
    thread_ts text,
    kind text not null check (kind in (
      'post', 'reaction', 'reaction_removal',
      'github_comment', 'github_reaction', 'github_reaction_removal'
    )),
    body text not null,
    status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
    attempts integer not null default 0,
    last_error text,
    next_attempt_at integer not null,
    slack_ts text,
    created_at integer not null,
    sent_at integer
  );
  insert into outbox_rebuilt
    select id, dedupe_key, channel, thread_ts, kind, body, status, attempts,
      last_error, next_attempt_at, slack_ts, created_at, sent_at
    from outbox;
  drop table outbox;
  alter table outbox_rebuilt rename to outbox;
  create index outbox_pending on outbox (next_attempt_at)
    where status = 'pending';
  `,
];

const userVersionSchema = z.object({ user_version: z.number() });

export const migrate = (
  database: DatabaseSync,
  transaction: Transaction,
  location: string,
): void => {
  const { user_version: currentVersion } = userVersionSchema.parse(
    database.prepare("pragma user_version").get(),
  );
  if (currentVersion > MIGRATIONS.length) {
    throw new Error(
      `The store at ${location} is at schema version ${currentVersion}, but this code only knows up to ${MIGRATIONS.length}. Update superagent before opening it.`,
    );
  }
  MIGRATIONS.slice(currentVersion).forEach((migration, offset) => {
    transaction(() => {
      database.exec(migration);
      database.exec(`pragma user_version = ${currentVersion + offset + 1}`);
    });
  });
};
