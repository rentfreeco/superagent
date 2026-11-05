import type { webApi } from "@slack/bolt";
import type { InboundMessage } from "./inbound.ts";

export const postReply = async (
  client: webApi.WebClient,
  { channel, threadTs }: Pick<InboundMessage, "channel" | "threadTs">,
  text: string,
): Promise<void> => {
  await client.chat.postMessage({ channel, thread_ts: threadTs, text });
};
