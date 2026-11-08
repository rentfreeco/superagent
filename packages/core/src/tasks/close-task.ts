import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS } from "../store/tasks.ts";
import { dropUnreadInputs } from "./drop-unread-inputs.ts";

export interface CloseRequest {
  store: Pick<Store, "tasks" | "inputs">;
  taskId: string;
}

/**
 * Ends a task whose pull request was merged or closed: drops what its
 * worker hadn't read and marks it done. A live session ends at its next
 * turn, since a report for a task that isn't running is turned down.
 */
export const closeTask = ({ store, taskId }: CloseRequest): void => {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error(`No task ${taskId}`);
  dropUnreadInputs(store, taskId);
  if (TASK_TRANSITIONS[task.state].includes("done")) {
    store.tasks.transition(taskId, "done");
  }
};
