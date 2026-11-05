import { type Repo, routeMessage } from "@repo/core/repos";
import type { InboundMessage } from "@repo/core/slack";
import type { Store } from "@repo/core/store";

export interface HandlerStore extends Pick<
  Store,
  "transaction" | "events" | "outbox"
> {}

export interface TaskRequest {
  message: InboundMessage;
  repo: Repo;
  store: HandlerStore;
}

export type StartTask = (request: TaskRequest) => void;

export interface MessageHandlerOptions {
  channelRepos: ReadonlyMap<string, Repo>;
  startTask: StartTask;
  store: HandlerStore;
  wakeOutbox: () => void;
}

export const createMessageHandler =
  ({ channelRepos, startTask, store, wakeOutbox }: MessageHandlerOptions) =>
  (message: InboundMessage): void => {
    const route = routeMessage(channelRepos, message);
    store.transaction(() => {
      if (route.kind === "reply") {
        store.outbox.enqueue({
          dedupeKey: `reply:${message.eventId}`,
          channel: message.channel,
          threadTs: message.threadTs,
          message: { kind: "post", text: route.text },
        });
        store.events.setDisposition(message.eventId, "replied");
        return;
      }
      startTask({ message, repo: route.repo, store });
      store.events.setDisposition(message.eventId, "routed");
    });
    wakeOutbox();
  };
