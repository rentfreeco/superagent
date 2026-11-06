import { TASK_STOP_REACTION } from "../constants.ts";
import type { InboundReaction } from "../slack/inbound.ts";
import type { EventDisposition } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { stopTask } from "./stop-task.ts";

export interface ReactionStore extends Pick<
  Store,
  "tasks" | "inputs" | "outbox" | "threads" | "events"
> {}

export interface TakenReaction {
  reaction: InboundReaction;
  store: ReactionStore;
}

export type ReactionDisposition = Extract<
  EventDisposition,
  "stopped_task" | "ignored"
>;

interface TaskThread {
  taskId: string;
  channel: string;
  threadTs: string;
}

const taskThreadAt = (
  store: ReactionStore,
  channel: string,
  threadTs: string,
): TaskThread | undefined => {
  const taskId = store.threads.owner(channel, threadTs)?.taskId;
  return taskId ? { taskId, channel, threadTs } : undefined;
};

const findTaskThread = (
  store: ReactionStore,
  { channel, ts }: Pick<InboundReaction, "channel" | "ts">,
): TaskThread | undefined => {
  const replyThreadTs = store.events.claimedMessage(channel, ts)?.threadTs;
  return (
    taskThreadAt(store, channel, ts) ??
    (replyThreadTs ? taskThreadAt(store, channel, replyThreadTs) : undefined)
  );
};

export const takeReaction = ({
  reaction,
  store,
}: TakenReaction): ReactionDisposition => {
  if (reaction.reaction !== TASK_STOP_REACTION) return "ignored";
  const thread = findTaskThread(store, reaction);
  if (thread === undefined) return "ignored";
  stopTask({ store, ...thread, eventId: reaction.eventId });
  return "stopped_task";
};
