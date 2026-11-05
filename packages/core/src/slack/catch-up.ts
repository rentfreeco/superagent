import type { App, webApi } from "@slack/bolt";
import { compareSlackTs } from "../utils/compare-slack-ts.ts";
import { readStringField } from "../utils/read-string-field.ts";

export interface CatchUpTarget {
  channel: string;
  threadTs: string | null;
  oldest: string;
}

export interface CatchUpResult {
  fed: number;
  failed: number;
}

export interface CatchUpContext {
  client: webApi.WebClient;
  app: App;
  ownerUserId: string;
  botUserId: string;
  teamId: string;
}

export interface MissedMessage {
  ts: string;
  user?: string;
  botId?: string;
  text?: string;
  threadTs?: string;
  subtype?: string;
}

export const catchUpEventId = (channel: string, ts: string): string =>
  `catchup:${channel}:${ts}`;

const fetchMessagesAfter = async (
  client: webApi.WebClient,
  { channel, threadTs, oldest }: CatchUpTarget,
): Promise<MissedMessage[]> => {
  const missedMessages: MissedMessage[] = [];
  let cursor: string | undefined;
  do {
    const page =
      threadTs === null
        ? await client.conversations.history({
            channel,
            oldest,
            limit: 200,
            cursor,
          })
        : await client.conversations.replies({
            channel,
            ts: threadTs,
            oldest,
            limit: 200,
            cursor,
          });
    for (const message of page.messages ?? []) {
      if (message.ts === undefined) continue;
      missedMessages.push({
        ts: message.ts,
        user: message.user,
        botId: message.bot_id,
        text: message.text,
        threadTs: message.thread_ts,
        subtype: readStringField(message, "subtype"),
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  return missedMessages
    .filter((message) => compareSlackTs(message.ts, oldest) > 0)
    .sort((left, right) => compareSlackTs(left.ts, right.ts));
};

export const toCatchUpEvent = (
  channel: string,
  message: MissedMessage,
  { ownerUserId, botUserId }: Pick<CatchUpContext, "ownerUserId" | "botUserId">,
): Record<string, unknown> | undefined => {
  if (message.user !== ownerUserId || message.botId !== undefined) {
    return undefined;
  }
  const fields = {
    channel,
    user: message.user,
    text: message.text ?? "",
    ts: message.ts,
    event_ts: message.ts,
    ...(message.threadTs === undefined ? {} : { thread_ts: message.threadTs }),
  };
  if (channel.startsWith("D")) {
    return {
      type: "message",
      channel_type: "im",
      ...(message.subtype === undefined ? {} : { subtype: message.subtype }),
      ...fields,
    };
  }
  const mentionsBot = new RegExp(`<@${botUserId}(\\|[^>]*)?>`).test(
    fields.text,
  );
  return mentionsBot ? { type: "app_mention", ...fields } : undefined;
};

export const catchUpConversation = async (
  context: CatchUpContext,
  target: CatchUpTarget,
): Promise<CatchUpResult> => {
  const result: CatchUpResult = { fed: 0, failed: 0 };
  for (const message of await fetchMessagesAfter(context.client, target)) {
    const event = toCatchUpEvent(target.channel, message, context);
    if (event === undefined) continue;
    try {
      await context.app.processEvent({
        body: {
          type: "event_callback",
          token: "catch-up",
          team_id: context.teamId,
          api_app_id: "catch-up",
          event_id: catchUpEventId(target.channel, message.ts),
          event_time: Math.floor(Number(message.ts)),
          event,
        },
        ack: async () => undefined,
      });
      result.fed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
};
