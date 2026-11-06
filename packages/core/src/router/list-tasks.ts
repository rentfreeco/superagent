import { ROUTER_TASK_LIST_LIMIT } from "../constants.ts";
import type { Store } from "../store/open-store.ts";
import type { Task, TaskState } from "../store/tasks.ts";

export const OPEN_TASK_STATES: readonly TaskState[] = [
  "queued",
  "running",
  "waiting",
  "ready",
  "blocked",
  "failed",
];

const ALL_TASK_STATES: readonly TaskState[] = [
  ...OPEN_TASK_STATES,
  "done",
  "stopped",
];

const describeTask = (task: Task): string =>
  [
    `- ${task.id} [${task.state}] ${task.title}`,
    `repo ${task.repo}`,
    `thread ${task.originChannel}/${task.originTs}`,
    ...(task.prNumber === null ? [] : [`PR #${task.prNumber}`]),
  ].join(", ");

export const listTasks = (
  store: Pick<Store, "tasks">,
  which: "open" | "all",
): string => {
  const tasks = store.tasks
    .withState(which === "open" ? OPEN_TASK_STATES : ALL_TASK_STATES)
    .slice(-ROUTER_TASK_LIST_LIMIT);
  return tasks.length === 0
    ? `There are no ${which === "open" ? "open " : ""}tasks.`
    : tasks.map(describeTask).join("\n");
};
