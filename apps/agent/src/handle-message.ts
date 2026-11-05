import { type Repo, routeMessage } from "@repo/core/repos";
import type { InboundMessage, SlackGateway } from "@repo/core/slack";

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
}

export const createMessageHandler =
  ({ channelRepos, startTask }: MessageHandlerOptions) =>
  async (message: InboundMessage, slack: SlackThreads): Promise<void> => {
    const route = routeMessage(channelRepos, message);
    if (route.kind === "reply") {
      await slack.reply(message, route.text);
      return;
    }
    await startTask({ message, repo: route.repo, slack });
  };
