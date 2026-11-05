import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TaskState } from "./tasks.ts";

const threadOwnerSchema = z.object({
  channel: z.string(),
  threadTs: z.string(),
  taskId: z.string().nullable(),
  createdAt: z.number(),
});

export interface ThreadOwner extends z.infer<typeof threadOwnerSchema> {}

export interface ThreadClaim {
  channel: string;
  threadTs: string;
  taskId: string | null;
}

export interface ThreadStore {
  owner(channel: string, threadTs: string): ThreadOwner | undefined;
  claim(claim: ThreadClaim): ThreadOwner;
  ownedByTasksIn(states: readonly TaskState[]): ThreadOwner[];
}

const THREAD_COLUMNS =
  "threads.channel, threads.thread_ts as threadTs, threads.task_id as taskId, threads.created_at as createdAt";

export const createThreadStore = (
  database: DatabaseSync,
  now: () => number,
): ThreadStore => {
  const selectOwner = database.prepare(
    `select ${THREAD_COLUMNS} from threads
     where channel = :channel and thread_ts = :threadTs`,
  );
  const insertOrHandOff = database.prepare(
    `insert into threads (channel, thread_ts, task_id, created_at)
     values (:channel, :threadTs, :taskId, :createdAt)
     on conflict (channel, thread_ts) do update set task_id = excluded.task_id
     where threads.task_id is null and excluded.task_id is not null`,
  );

  const owner = (
    channel: string,
    threadTs: string,
  ): ThreadOwner | undefined => {
    const row = selectOwner.get({ channel, threadTs });
    return row === undefined ? undefined : threadOwnerSchema.parse(row);
  };

  return {
    owner,
    claim: ({ channel, threadTs, taskId }) => {
      insertOrHandOff.run({ channel, threadTs, taskId, createdAt: now() });
      return threadOwnerSchema.parse(selectOwner.get({ channel, threadTs }));
    },
    ownedByTasksIn: (states) => {
      if (states.length === 0) return [];
      const placeholders = states.map(() => "?").join(", ");
      return database
        .prepare(
          `select ${THREAD_COLUMNS} from threads
           join tasks on tasks.id = threads.task_id
           where tasks.state in (${placeholders})
           order by threads.created_at, threads.channel, threads.thread_ts`,
        )
        .all(...states)
        .map((row) => threadOwnerSchema.parse(row));
    },
  };
};
