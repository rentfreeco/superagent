import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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
}

const THREAD_COLUMNS =
  "channel, thread_ts as threadTs, task_id as taskId, created_at as createdAt";

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
  };
};
