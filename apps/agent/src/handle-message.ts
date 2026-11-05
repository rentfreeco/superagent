import { type Repo, routeMessage } from "@repo/core/repos";
import type { InboundMessage, SlackGateway } from "@repo/core/slack";
import type { EventStore } from "@repo/core/store";

export interface SlackThreads extends Pick<
  SlackGateway,
  "reply" | "fetchThread"
> {}

export interface TaskRequest {
  message: InboundMessage;
  repo: Repo;
  slack: SlackThreads;
}

export type StartTask = (request: TaskRequest) => Promise<void>;

export interface MessageHandlerOptions {
  channelRepos: ReadonlyMap<string, Repo>;
  startTask: StartTask;
  events: Pick<EventStore, "setDisposition">;
}

export const createMessageHandler =
  ({ channelRepos, startTask, events }: MessageHandlerOptions) =>
  async (message: InboundMessage, slack: SlackThreads): Promise<void> => {
    const route = routeMessage(channelRepos, message);
    if (route.kind === "reply") {
      await slack.reply(message, route.text);
      events.setDisposition(message.eventId, "replied");
      return;
    }
    await startTask({ message, repo: route.repo, slack });
    events.setDisposition(message.eventId, "routed");
  };
