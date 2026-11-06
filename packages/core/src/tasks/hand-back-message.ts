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
  inputId: number;
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

const refused = (reply: string): ToolOutcome => ({ isAccepted: false, reply });

/**
 * Hands a Slack message the worker was given back to the router, as a
 * candidate that names the task and why.
 */
export const handBackMessage = ({
  store,
  taskId,
  inputId,
  reason,
}: HandBackOptions): ToolOutcome =>
  store.transaction(() => {
    const input = store.inputs.get(inputId);
    if (input?.taskId !== taskId || input.deliveredAt === null) {
      return refused(`You haven't been given a message ${inputId}.`);
    }
    const message =
      input.ref === null
        ? undefined
        : toOwnerMessage(input, store.events.get(input.ref));
    if (message === undefined) {
      return refused(
        `Message ${inputId} isn't a Slack message from the owner, so it can't be handed back.`,
      );
    }
    if (store.inputs.first(taskId)?.id === inputId) {
      return refused(
        "That is the request this task was started for, so it can't be handed back. If it can't be done here, report failed with why.",
      );
    }
    const candidate = store.candidates.add({
      ...message,
      handedBackBy: taskId,
      handBackReason: reason,
    });
    return candidate === undefined
      ? refused(`You already handed message ${inputId} back.`)
      : {
          isAccepted: true,
          reply: `Handed message ${inputId} back. superagent's router decides what happens to it, so carry on with the task as if it hadn't arrived.`,
        };
  });
