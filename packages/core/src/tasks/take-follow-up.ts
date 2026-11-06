import type { InboundMessage } from "../slack/inbound.ts";
import type { EventDisposition } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS, type Task } from "../store/tasks.ts";

export interface FollowUpStore extends Pick<
  Store,
  "tasks" | "inputs" | "outbox"
> {}

export interface FollowUp {
  message: InboundMessage;
  taskId: string;
  store: FollowUpStore;
}

export type FollowUpDisposition = Extract<
  EventDisposition,
  "task_input" | "stopped_task"
>;

type StopOutcome = "stopped" | "cancelled" | "unchanged";

const STOP_REQUEST = /^stop[.!]?$/i;

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

const stopTask = ({ message, taskId, store }: FollowUp): void => {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error(`No task ${taskId}`);
  const hasWaitingInput = store.inputs.undelivered(taskId).length > 0;
  const canStop = TASK_TRANSITIONS[task.state].includes("stopped");
  if (canStop) store.tasks.transition(taskId, "stopped");
  const droppedInputIds = store.inputs.unread(taskId).map(({ id }) => id);
  store.inputs.markDelivered(droppedInputIds);
  store.inputs.markRead(droppedInputIds);
  const outcome: StopOutcome = canStop
    ? "stopped"
    : hasWaitingInput
      ? "cancelled"
      : "unchanged";
  store.outbox.enqueue({
    dedupeKey: `stop:${message.eventId}`,
    channel: message.channel,
    threadTs: message.threadTs,
    message: { kind: "post", text: describeStop(task, outcome) },
  });
};

export const takeFollowUp = (followUp: FollowUp): FollowUpDisposition => {
  const { message, taskId, store } = followUp;
  if (STOP_REQUEST.test(message.text.trim())) {
    stopTask(followUp);
    return "stopped_task";
  }
  store.inputs.add({
    taskId,
    source: "slack",
    ref: message.eventId,
    text: message.text,
  });
  return "task_input";
};
