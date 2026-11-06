import type { InboundMessage } from "../slack/inbound.ts";
import type { StoredEvent } from "../store/events.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { Store } from "../store/open-store.ts";
import type { ToolOutcome } from "./tool-outcome.ts";

export interface HandBackOptions {
  store: Pick<
    Store,
    "transaction" | "tasks" | "inputs" | "events" | "candidates"
  >;
  taskId: string;
  reason: string;
}

const viaOf = ({ type, channel }: StoredEvent): InboundMessage["via"] => {
  if (type === "app_mention") return "mention";
  return channel?.startsWith("D") ? "dm" : "thread";
};

const toOwnerMessage = (
  input: TaskInput,
  event: StoredEvent | undefined,
): InboundMessage | undefined => {
  if (
    event === undefined ||
    event.channel === null ||
    event.ts === null ||
    event.user === null
  ) {
    return undefined;
  }
  return {
    eventId: event.eventId,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.threadTs ?? event.ts,
    user: event.user,
    text: event.text ?? input.text,
    via: viaOf(event),
  };
};

/**
 * Hands the newest Slack message the worker was given this turn back to the
 * router, as a candidate that names the task and why.
 */
export const handBackMessage = ({
  store,
  taskId,
  reason,
}: HandBackOptions): ToolOutcome =>
  store.transaction(() => {
    const task = store.tasks.get(taskId);
    if (task === undefined) {
      return { isAccepted: false, reply: `There is no task ${taskId}.` };
    }
    const message = store.inputs
      .unread(taskId)
      .flatMap((input) => {
        if (input.ref === null || input.deliveredAt === null) return [];
        const ownerMessage = toOwnerMessage(input, store.events.get(input.ref));
        return ownerMessage === undefined ? [] : [ownerMessage];
      })
      .at(-1);
    if (message === undefined) {
      return {
        isAccepted: false,
        reply: "No message from the owner arrived this turn to hand back.",
      };
    }
    if (
      message.channel === task.originChannel &&
      message.ts === task.originTs
    ) {
      return {
        isAccepted: false,
        reply:
          "That is the request this task was started for, so it can't be handed back. If it can't be done here, report failed with why.",
      };
    }
    const candidate = store.candidates.add({
      ...message,
      handedBackBy: taskId,
      handBackReason: reason,
    });
    return candidate === undefined
      ? { isAccepted: false, reply: "You already handed this message back." }
      : {
          isAccepted: true,
          reply:
            "Handed the message back. superagent's router decides what happens to it, so carry on with the task as if it hadn't arrived.",
        };
  });
