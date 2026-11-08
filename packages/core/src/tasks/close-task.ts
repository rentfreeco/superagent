import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS } from "../store/tasks.ts";
import { dropUnreadInputs } from "./drop-unread-inputs.ts";

export interface CloseRequest {
  store: Pick<Store, "tasks" | "inputs">;
  taskId: string;
}

/**
 * Ends a task whose pull request was merged or closed: drops what its
 * worker hadn't read, and marks it done and closed, even when its worker
 * had already reported done. The runner interrupts a live session, which
 * can't reopen it; the owner's next message can.
 */
export const closeTask = ({ store, taskId }: CloseRequest): void => {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error(`No task ${taskId}`);
  dropUnreadInputs(store, taskId);
  if (TASK_TRANSITIONS[task.state].includes("done")) {
    store.tasks.transition(taskId, "done");
  }
  if (store.tasks.get(taskId)?.state === "done") store.tasks.markClosed(taskId);
};
