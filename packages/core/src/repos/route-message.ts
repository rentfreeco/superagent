import type { InboundMessage } from "../slack/inbound.ts";
import type { Repo } from "./config.ts";

export interface RepoRoute {
  kind: "repo";
  repo: Repo;
}

export interface ReplyRoute {
  kind: "reply";
  text: string;
}

export type MessageRoute = RepoRoute | ReplyRoute;

const describeChannels = (channelRepos: ReadonlyMap<string, Repo>): string =>
  [...channelRepos]
    .map(([channelId, repo]) => `<#${channelId}> (${repo.name})`)
    .join(", ");

const directMessageReply = (channelRepos: ReadonlyMap<string, Repo>): string =>
  channelRepos.size === 0
    ? "DMs don't map to a repo, and no channels are mapped yet. Add one under `channels` in the superagent config."
    : `DMs don't map to a repo. Mention me in a repo channel instead: ${describeChannels(channelRepos)}.`;

const unmappedChannelReply = (channelId: string): string =>
  `This channel isn't mapped to a repo. Add \`${channelId}: "<repo name>"\` under \`channels\` in the superagent config, then restart me.`;

export const routeMessage = (
  channelRepos: ReadonlyMap<string, Repo>,
  message: Pick<InboundMessage, "channel" | "via">,
): MessageRoute => {
  if (message.via === "dm") {
    return { kind: "reply", text: directMessageReply(channelRepos) };
  }
  const repo = channelRepos.get(message.channel);
  if (repo) return { kind: "repo", repo };
  return { kind: "reply", text: unmappedChannelReply(message.channel) };
};
