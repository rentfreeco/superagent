import { type Repo, routeMessage } from "@repo/core/repos";
import type { InboundMessage } from "@repo/core/slack";
import type { Store } from "@repo/core/store";
import { takeFollowUp, type TaskRequest } from "@repo/core/tasks";

export interface HandlerStore extends Pick<
  Store,
  "transaction" | "events" | "outbox" | "tasks" | "threads" | "inputs"
> {}

export type StartTask = (request: TaskRequest) => undefined;

export interface MessageHandlerOptions {
  channelRepos: ReadonlyMap<string, Repo>;
  startTask: StartTask;
  store: HandlerStore;
  wakeOutbox: () => void;
  wakeTaskRunner: () => void;
}

export const createMessageHandler =
  ({
    channelRepos,
    startTask,
    store,
    wakeOutbox,
    wakeTaskRunner,
  }: MessageHandlerOptions) =>
  (message: InboundMessage): void => {
    const route = routeMessage(channelRepos, message);
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
      const started: unknown = startTask({ message, repo: route.repo, store });
      if (started instanceof Promise) {
        throw new Error(
          "startTask returned a promise. It runs inside the handler's transaction, so it must be synchronous and only write rows.",
        );
      }
      store.events.setDisposition(message.eventId, "routed");
    });
    wakeOutbox();
    wakeTaskRunner();
  };
