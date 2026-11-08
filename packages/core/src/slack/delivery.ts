import { webApi } from "@slack/bolt";
import type { BotIdentity } from "./thread.ts";

export const OUTBOX_METADATA_EVENT_TYPE = "superagent_outbox";

export interface SlackPost {
  channel: string;
  threadTs: string | null;
  text: string;
  dedupeKey: string;
}

export interface SlackReaction {
  channel: string;
  timestamp: string;
  name: string;
}

export interface SlackPostQuery {
  channel: string;
  threadTs: string | null;
  dedupeKey: string;
  postedAfter: number;
}

export interface PermanentDeliveryFailure {
  kind: "permanent";
}

export interface TransientDeliveryFailure {
  kind: "transient";
  retryAfterMs?: number;
}

export type DeliveryFailure =
  PermanentDeliveryFailure | TransientDeliveryFailure;

const TRANSIENT_PLATFORM_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

export const platformErrorCode = (error: unknown): string | undefined => {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== webApi.ErrorCode.PlatformError ||
    !("data" in error) ||
    typeof error.data !== "object" ||
    error.data === null ||
    !("error" in error.data) ||
    typeof error.data.error !== "string"
  ) {
    return undefined;
  }
  return error.data.error;
};

const retryAfterMs = (error: unknown): number | undefined => {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== webApi.ErrorCode.RateLimitedError ||
    !("retryAfter" in error) ||
    typeof error.retryAfter !== "number"
  ) {
    return undefined;
  }
  return error.retryAfter * 1_000;
};

export const classifyDeliveryFailure = (error: unknown): DeliveryFailure => {
  const code = platformErrorCode(error);
  if (code === undefined || TRANSIENT_PLATFORM_ERRORS.has(code)) {
    return { kind: "transient", retryAfterMs: retryAfterMs(error) };
  }
  return { kind: "permanent" };
};

export const postMessage = async (
  client: webApi.WebClient,
  { channel, threadTs, text, dedupeKey }: SlackPost,
): Promise<string> => {
  const result = await client.chat.postMessage({
    channel,
    thread_ts: threadTs ?? undefined,
    text,
    metadata: {
      event_type: OUTBOX_METADATA_EVENT_TYPE,
      event_payload: { dedupe_key: dedupeKey },
    },
  });
  if (result.ts === undefined) {
    throw new Error("slack: chat.postMessage returned no ts");
  }
  return result.ts;
};

export const addReaction = async (
  client: webApi.WebClient,
  { channel, timestamp, name }: SlackReaction,
): Promise<void> => {
  try {
    await client.reactions.add({ channel, timestamp, name });
  } catch (error) {
    if (platformErrorCode(error) !== "already_reacted") throw error;
  }
};

/** Removes the bot's reaction; one that's already gone counts as removed. */
export const removeReaction = async (
  client: webApi.WebClient,
  { channel, timestamp, name }: SlackReaction,
): Promise<void> => {
  try {
    await client.reactions.remove({ channel, timestamp, name });
  } catch (error) {
    if (platformErrorCode(error) !== "no_reaction") throw error;
  }
};

const readDedupeKey = (metadata: unknown): string | undefined => {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const payload: unknown = Reflect.get(metadata, "event_payload");
  if (typeof payload !== "object" || payload === null) return undefined;
  const dedupeKey: unknown = Reflect.get(payload, "dedupe_key");
  return typeof dedupeKey === "string" ? dedupeKey : undefined;
};

const toSlackTs = (epochMs: number): string => (epochMs / 1000).toFixed(6);

export const findOwnPost = async (
  client: webApi.WebClient,
  identity: BotIdentity,
  { channel, threadTs, dedupeKey, postedAfter }: SlackPostQuery,
): Promise<string | undefined> => {
  let cursor: string | undefined;
  do {
    const page =
      threadTs === null
        ? await client.conversations.history({
            channel,
            oldest: toSlackTs(postedAfter),
            include_all_metadata: true,
            limit: 200,
            cursor,
          })
        : await client.conversations.replies({
            channel,
            ts: threadTs,
            oldest: toSlackTs(postedAfter),
            include_all_metadata: true,
            limit: 200,
            cursor,
          });
    const ownPost = (page.messages ?? []).find(
      (message) =>
        message.bot_id === identity.botId &&
        readDedupeKey(message.metadata) === dedupeKey,
    );
    if (ownPost?.ts !== undefined) return ownPost.ts;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor !== undefined);
  return undefined;
};
