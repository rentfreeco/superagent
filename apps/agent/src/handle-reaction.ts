import type { InboundReaction } from "@repo/core/slack";
import type { Store } from "@repo/core/store";
import { takeReaction } from "@repo/core/tasks";

export interface ReactionHandlerOptions {
  store: Pick<
    Store,
    "transaction" | "events" | "tasks" | "inputs" | "outbox" | "threads"
  >;
  wakeOutbox: () => void;
  wakeTaskRunner: () => void;
}

export const createReactionHandler =
  ({ store, wakeOutbox, wakeTaskRunner }: ReactionHandlerOptions) =>
  (reaction: InboundReaction): void => {
    store.transaction(() => {
      store.events.setDisposition(
        reaction.eventId,
        takeReaction({ reaction, store }),
      );
    });
    wakeOutbox();
    wakeTaskRunner();
  };
