import { queueCandidate } from "@repo/core/router";
import type { InboundMessage } from "@repo/core/slack";
import type { Store } from "@repo/core/store";
import { takeFollowUp } from "@repo/core/tasks";

export interface HandlerStore extends Pick<
  Store,
  | "transaction"
  | "events"
  | "outbox"
  | "tasks"
  | "threads"
  | "inputs"
  | "candidates"
> {}

export interface MessageHandlerOptions {
  store: HandlerStore;
  wakeOutbox: () => void;
  wakeTaskRunner: () => void;
  wakeRouter: () => void;
}

export const createMessageHandler =
  ({ store, wakeOutbox, wakeTaskRunner, wakeRouter }: MessageHandlerOptions) =>
  (message: InboundMessage): void => {
    store.transaction(() => {
      const owningTaskId = store.threads.owner(
        message.channel,
        message.threadTs,
      )?.taskId;
      if (owningTaskId) {
        store.events.setDisposition(
          message.eventId,
          takeFollowUp({ message, taskId: owningTaskId, store }),
        );
        return;
      }
      if (message.via === "thread") {
        store.events.setDisposition(message.eventId, "ignored");
        return;
      }
      queueCandidate({ message, store });
    });
    wakeOutbox();
    wakeTaskRunner();
    wakeRouter();
  };
