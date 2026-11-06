import { TASK_ACK_REACTION } from "../constants.ts";
import type { Store } from "../store/open-store.ts";

export interface AcknowledgeMessagesOptions {
  store: Pick<Store, "transaction" | "inputs" | "events" | "outbox">;
  taskId: string;
}

export const acknowledgeMessages = ({
  store,
  taskId,
}: AcknowledgeMessagesOptions): number =>
  store.transaction(() => {
    let acknowledgedCount = 0;
    for (const { ref, deliveredAt } of store.inputs.unread(taskId)) {
      if (ref === null || deliveredAt === null) continue;
      const event = store.events.get(ref);
      if (event === undefined || event.channel === null || event.ts === null) {
        continue;
      }
      const reaction = store.outbox.enqueue({
        dedupeKey: `ack:${ref}`,
        channel: event.channel,
        threadTs: null,
        message: {
          kind: "reaction",
          name: TASK_ACK_REACTION,
          timestamp: event.ts,
        },
      });
      if (reaction !== undefined) acknowledgedCount += 1;
    }
    return acknowledgedCount;
  });
