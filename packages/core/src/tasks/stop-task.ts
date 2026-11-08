import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS, type Task } from "../store/tasks.ts";
import { dropUnreadInputs } from "./drop-unread-inputs.ts";

export interface StopRequest {
  store: Pick<Store, "tasks" | "inputs" | "outbox">;
  taskId: string;
  /** The event that asked for the stop, which keys the confirmation post. */
  eventId: string;
  channel: string;
  threadTs: string;
}

type StopOutcome = "stopped" | "cancelled" | "unchanged";

const describeStop = (task: Task, outcome: StopOutcome): string => {
  switch (outcome) {
    case "stopped":
      return task.branch === null
        ? "Stopped before any work started."
        : `Stopped. The branch \`${task.branch}\` is kept.`;
    case "cancelled":
      return `Cancelled. This task stays ${task.state}, and the messages waiting for it are dropped.`;
    case "unchanged":
      return `Nothing to stop: this task is already ${task.state}.`;
  }
};

export const stopTask = ({
  store,
  taskId,
  eventId,
  channel,
  threadTs,
}: StopRequest): void => {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error(`No task ${taskId}`);
  const hasWaitingInput = store.inputs.undelivered(taskId).length > 0;
  const canStop = TASK_TRANSITIONS[task.state].includes("stopped");
  if (canStop) store.tasks.transition(taskId, "stopped");
  dropUnreadInputs(store, taskId);
  const outcome: StopOutcome = canStop
    ? "stopped"
    : hasWaitingInput
      ? "cancelled"
      : "unchanged";
  store.outbox.enqueue({
    dedupeKey: `stop:${eventId}`,
    channel,
    threadTs,
    message: { kind: "post", text: describeStop(task, outcome) },
  });
};
