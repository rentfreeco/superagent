import { TASK_ACK_REACTION } from "../constants.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import type { OutboxStore } from "../store/outbox.ts";

export const acknowledgeMessage = (
  message: Pick<InboundMessage, "eventId" | "channel" | "ts">,
  outbox: Pick<OutboxStore, "enqueue">,
): void => {
  outbox.enqueue({
    dedupeKey: `ack:${message.eventId}`,
    channel: message.channel,
    threadTs: null,
    message: {
      kind: "reaction",
      name: TASK_ACK_REACTION,
      timestamp: message.ts,
    },
  });
};
