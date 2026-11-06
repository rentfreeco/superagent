import type { InboundMessage } from "../slack/inbound.ts";
import type { EventDisposition } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { stopTask } from "./stop-task.ts";

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

export const takeFollowUp = ({
  message,
  taskId,
  store,
}: FollowUp): FollowUpDisposition => {
  if (STOP_REQUEST.test(message.text.trim())) {
    stopTask({
      store,
      taskId,
      eventId: message.eventId,
      channel: message.channel,
      threadTs: message.threadTs,
    });
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
