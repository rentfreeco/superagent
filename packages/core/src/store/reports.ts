import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { taskStateSchema, type TaskState } from "./tasks.ts";

const taskReportSchema = z.object({
  id: z.number(),
  taskId: z.string(),
  state: taskStateSchema,
  summary: z.string().nullable(),
  question: z.string().nullable(),
  createdAt: z.number(),
});

export interface TaskReport extends z.infer<typeof taskReportSchema> {}

export interface NewTaskReport {
  taskId: string;
  state: TaskState;
  summary: string | null;
  question: string | null;
}

export interface ReportStore {
  add(report: NewTaskReport): TaskReport;
  latest(taskId: string): TaskReport | undefined;
}

const REPORT_COLUMNS =
  "id, task_id as taskId, state, summary, question, created_at as createdAt";

export const createReportStore = (
  database: DatabaseSync,
  now: () => number,
): ReportStore => {
  const insertReport = database.prepare(
    `insert into reports (task_id, state, summary, question, created_at)
     values (:taskId, :state, :summary, :question, :now)
     returning ${REPORT_COLUMNS}`,
  );
  const selectLatest = database.prepare(
    `select ${REPORT_COLUMNS} from reports
     where task_id = :taskId order by id desc limit 1`,
  );

  return {
    add: ({ taskId, state, summary, question }) =>
      taskReportSchema.parse(
        insertReport.get({ taskId, state, summary, question, now: now() }),
      ),
    latest: (taskId) => {
      const row = selectLatest.get({ taskId });
      return row === undefined ? undefined : taskReportSchema.parse(row);
    },
  };
};
