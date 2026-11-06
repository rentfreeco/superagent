import type { DatabaseSync, StatementSync } from "node:sqlite";
import { z } from "zod";
import type { Transaction } from "./transaction.ts";

export const inputSourceSchema = z.enum([
  "slack",
  "github",
  "router",
  "system",
]);

export type InputSource = z.infer<typeof inputSourceSchema>;

const taskInputSchema = z.object({
  id: z.number(),
  taskId: z.string(),
  source: inputSourceSchema,
  ref: z.string().nullable(),
  text: z.string(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
  readAt: z.number().nullable(),
});

export interface TaskInput extends z.infer<typeof taskInputSchema> {}

export interface NewTaskInput {
  taskId: string;
  source: InputSource;
  ref: string | null;
  text: string;
}

export interface InputStore {
  add(input: NewTaskInput): TaskInput | undefined;
  get(inputId: number): TaskInput | undefined;
  /** The input the task was started with. */
  first(taskId: string): TaskInput | undefined;
  undelivered(taskId: string): TaskInput[];
  unread(taskId: string): TaskInput[];
  tasksWithUndelivered(): string[];
  markDelivered(inputIds: readonly number[]): void;
  markRead(inputIds: readonly number[]): void;
}

const INPUT_COLUMNS =
  "id, task_id as taskId, source, ref, text, created_at as createdAt, delivered_at as deliveredAt, read_at as readAt";

const taskIdSchema = z.object({ taskId: z.string() });

export const createInputStore = (
  database: DatabaseSync,
  transaction: Transaction,
  now: () => number,
): InputStore => {
  const insertInput = database.prepare(
    `insert into inputs (task_id, source, ref, text, created_at)
     values (:taskId, :source, :ref, :text, :now)
     on conflict (source, ref) do nothing
     returning ${INPUT_COLUMNS}`,
  );
  const selectInput = database.prepare(
    `select ${INPUT_COLUMNS} from inputs where id = :inputId`,
  );
  const selectFirst = database.prepare(
    `select ${INPUT_COLUMNS} from inputs
     where task_id = :taskId order by id limit 1`,
  );
  const selectUndelivered = database.prepare(
    `select ${INPUT_COLUMNS} from inputs
     where task_id = :taskId and delivered_at is null order by id`,
  );
  const selectUnread = database.prepare(
    `select ${INPUT_COLUMNS} from inputs
     where task_id = :taskId and read_at is null order by id`,
  );
  const selectTasksWithUndelivered = database.prepare(
    `select distinct task_id as taskId from inputs
     where delivered_at is null order by task_id`,
  );
  const updateDelivered = database.prepare(
    "update inputs set delivered_at = :now where id = :id and delivered_at is null",
  );
  const updateRead = database.prepare(
    "update inputs set read_at = :now where id = :id and read_at is null",
  );

  const markEach = (
    statement: StatementSync,
    inputIds: readonly number[],
  ): void => {
    const markedAt = now();
    transaction(() => {
      for (const id of inputIds) statement.run({ id, now: markedAt });
    });
  };

  return {
    add: ({ taskId, source, ref, text }) => {
      const row = insertInput.get({ taskId, source, ref, text, now: now() });
      return row === undefined ? undefined : taskInputSchema.parse(row);
    },
    get: (inputId) => {
      const row = selectInput.get({ inputId });
      return row === undefined ? undefined : taskInputSchema.parse(row);
    },
    first: (taskId) => {
      const row = selectFirst.get({ taskId });
      return row === undefined ? undefined : taskInputSchema.parse(row);
    },
    undelivered: (taskId) =>
      selectUndelivered
        .all({ taskId })
        .map((row) => taskInputSchema.parse(row)),
    unread: (taskId) =>
      selectUnread.all({ taskId }).map((row) => taskInputSchema.parse(row)),
    tasksWithUndelivered: () =>
      selectTasksWithUndelivered
        .all()
        .map((row) => taskIdSchema.parse(row).taskId),
    markDelivered: (inputIds) => markEach(updateDelivered, inputIds),
    markRead: (inputIds) => markEach(updateRead, inputIds),
  };
};
