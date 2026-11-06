import type { InboundMessage } from "../slack/inbound.ts";
import type { EventDisposition } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { TASK_TRANSITIONS, type Task } from "../store/tasks.ts";
import { acknowledgeMessage } from "./acknowledge-message.ts";

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

const STOP_REQUEST = /^stop[.!]?$/i;

const describeStop = (task: Task, didStop: boolean): string => {
  if (!didStop) return `Nothing to stop: this task is already ${task.state}.`;
  return task.branch === null
    ? "Stopped before any work started."
    : `Stopped. The branch \`${task.branch}\` is kept.`;
};

const stopTask = ({ message, taskId, store }: FollowUp): void => {
  const task = store.tasks.get(taskId);
  if (task === undefined) throw new Error(`No task ${taskId}`);
  const canStop = TASK_TRANSITIONS[task.state].includes("stopped");
  if (canStop) {
    store.tasks.transition(taskId, "stopped");
    const discardedInputIds = store.inputs.unread(taskId).map(({ id }) => id);
    store.inputs.markDelivered(discardedInputIds);
    store.inputs.markRead(discardedInputIds);
  }
  store.outbox.enqueue({
    dedupeKey: `stop:${message.eventId}`,
    channel: message.channel,
    threadTs: message.threadTs,
    message: { kind: "post", text: describeStop(task, canStop) },
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
  acknowledgeMessage(message, store.outbox);
  return "task_input";
};
