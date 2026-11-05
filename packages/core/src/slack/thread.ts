import type { webApi } from "@slack/bolt";

/** Who the bot is in the workspace, as reported by auth.test. */
export interface BotIdentity {
  /** The bot user's ID (U…), which is what @-mentions reference. */
  userId: string;
  /** The bot's ID (B…), which is what its own posts carry as bot_id. */
  botId: string;
}

export interface ThreadMessage {
  ts: string;
  user?: string;
  botId?: string;
  text: string;
  /** Whether this bot posted the message. */
  fromSelf: boolean;
}

/** Reads every message in a thread, root first, following pagination to the end. */
export async function fetchThread(
  client: webApi.WebClient,
  identity: BotIdentity,
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const messages: ThreadMessage[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    for (const message of page.messages ?? []) {
      if (message.ts === undefined) continue;
      messages.push({
        ts: message.ts,
        user: message.user,
        botId: message.bot_id,
        text: message.text ?? "",
        fromSelf:
          message.bot_id === identity.botId || message.user === identity.userId,
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  return messages;
}
