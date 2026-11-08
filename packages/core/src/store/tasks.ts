import type { DatabaseSync, StatementSync } from "node:sqlite";
import { z } from "zod";
import { generateTaskId } from "../utils/generate-task-id.ts";

export const taskStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "ready",
  "done",
  "blocked",
  "failed",
  "stopped",
]);

export type TaskState = z.infer<typeof taskStateSchema>;

export const TASK_TRANSITIONS: Readonly<
  Record<TaskState, readonly TaskState[]>
> = {
  queued: ["running", "failed", "stopped"],
  running: ["waiting", "ready", "done", "blocked", "failed", "stopped"],
  waiting: ["running", "done", "stopped"],
  ready: ["running", "done", "stopped"],
  done: ["running"],
  blocked: ["running", "done"],
  failed: ["running", "done"],
  stopped: ["running", "done"],
};

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  state: taskStateSchema,
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  prNumber: z.number().nullable(),
  sessionId: z.string().nullable(),
  originChannel: z.string(),
  originTs: z.string(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  /** When its pull request closed it; its next transition clears this. */
  closedAt: z.number().nullable(),
});

export interface Task extends z.infer<typeof taskSchema> {}

export interface NewTask {
  title: string;
  repo: string;
  originChannel: string;
  originTs: string;
}

export interface TaskChanges {
  title?: string;
  branch?: string | null;
  worktree?: string | null;
  prNumber?: number | null;
  sessionId?: string | null;
}

export interface TaskStore {
  create(task: NewTask): Task;
  get(id: string): Task | undefined;
  update(id: string, changes: TaskChanges): Task;
  transition(id: string, to: TaskState): Task;
  /** Records that its pull request closed this done task, so no session reopens it; the owner's next message does. */
  markClosed(id: string): Task;
  withState(states: readonly TaskState[]): Task[];
  /** Tasks whose worker reported a pull request, oldest first. */
  withPullRequest(): Task[];
}

const TASK_COLUMNS =
  "id, title, repo, state, branch, worktree, pr_number as prNumber, session_id as sessionId, origin_channel as originChannel, origin_ts as originTs, created_at as createdAt, last_activity_at as lastActivityAt, closed_at as closedAt";

const TASK_CHANGE_COLUMNS: readonly (readonly [keyof TaskChanges, string])[] = [
  ["title", "title"],
  ["branch", "branch"],
  ["worktree", "worktree"],
  ["prNumber", "pr_number"],
  ["sessionId", "session_id"],
];

export const createTaskStore = (
  database: DatabaseSync,
  now: () => number,
): TaskStore => {
  const selectWithPullRequest = database.prepare(
    `select ${TASK_COLUMNS} from tasks
     where pr_number is not null order by created_at, id`,
  );
  const insertTask = database.prepare(
    `insert into tasks (id, title, repo, state, origin_channel, origin_ts, created_at, last_activity_at)
     values (:id, :title, :repo, 'queued', :originChannel, :originTs, :now, :now)
     returning ${TASK_COLUMNS}`,
  );
  const selectTask = database.prepare(
    `select ${TASK_COLUMNS} from tasks where id = :id`,
  );
  const markTaskClosed = database.prepare(
    `update tasks set closed_at = :now
     where id = :id and state = 'done'
     returning ${TASK_COLUMNS}`,
  );
  const transitionStatements = new Map<TaskState, StatementSync>(
    taskStateSchema.options.map((to) => {
      const fromStates = taskStateSchema.options
        .filter((from) => TASK_TRANSITIONS[from].includes(to))
        .map((from) => `'${from}'`)
        .join(", ");
      return [
        to,
        database.prepare(
          `update tasks set state = :to, closed_at = null, last_activity_at = :now
           where id = :id and state in (${fromStates})
           returning ${TASK_COLUMNS}`,
        ),
      ];
    }),
  );

  const get = (id: string): Task | undefined => {
    const row = selectTask.get({ id });
    return row === undefined ? undefined : taskSchema.parse(row);
  };

  const requireTask = (id: string): Task => {
    const task = get(id);
    if (task === undefined) throw new Error(`No task ${id}`);
    return task;
  };

  return {
    create: ({ title, repo, originChannel, originTs }) =>
      taskSchema.parse(
        insertTask.get({
          id: generateTaskId(),
          title,
          repo,
          originChannel,
          originTs,
          now: now(),
        }),
      ),
    get,
    update: (id, changes) => {
      const changedColumns = TASK_CHANGE_COLUMNS.filter(
        ([key]) => changes[key] !== undefined,
      );
      if (changedColumns.length === 0) return requireTask(id);
      const assignments = changedColumns
        .map(([key, column]) => `${column} = :${key}`)
        .join(", ");
      const row = database
        .prepare(
          `update tasks set ${assignments}, last_activity_at = :now
           where id = :id returning ${TASK_COLUMNS}`,
        )
        .get({
          ...Object.fromEntries(
            changedColumns.map(([key]) => [key, changes[key] ?? null]),
          ),
          id,
          now: now(),
        });
      if (row === undefined) throw new Error(`No task ${id}`);
      return taskSchema.parse(row);
    },
    transition: (id, to) => {
      const row = transitionStatements.get(to)?.get({ id, to, now: now() });
      if (row !== undefined) return taskSchema.parse(row);
      const task = requireTask(id);
      throw new Error(`Task ${id} can't move from ${task.state} to ${to}`);
    },
    withState: (states) => {
      if (states.length === 0) return [];
      const placeholders = states.map(() => "?").join(", ");
      return database
        .prepare(
          `select ${TASK_COLUMNS} from tasks
           where state in (${placeholders}) order by created_at, id`,
        )
        .all(...states)
        .map((row) => taskSchema.parse(row));
    },
    withPullRequest: () =>
      selectWithPullRequest.all().map((row) => taskSchema.parse(row)),
    markClosed: (id) => {
      const row = markTaskClosed.get({ id, now: now() });
      if (row !== undefined) return taskSchema.parse(row);
      const task = requireTask(id);
      throw new Error(`Task ${id} is ${task.state}, so it can't be closed`);
    },
  };
};
