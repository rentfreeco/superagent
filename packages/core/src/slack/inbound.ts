import type { AllMiddlewareArgs, AnyMiddlewareArgs, App } from "@slack/bolt";
import { Deduper } from "./dedupe.ts";

/** A request from the owner, addressed to the bot. */
export interface InboundMessage {
  /** event_id of the delivery that carried the message. */
  eventId: string;
  channel: string;
  /** This message's ts. */
  ts: string;
  /** ts of the thread root. A top-level message roots its own thread. */
  threadTs: string;
  user: string;
  /** Message text with the bot's @-mention removed. */
  text: string;
  /** A direct message to the bot, or an @-mention of it in a channel. */
  via: "dm" | "mention";
}

export type MessageHandler = (message: InboundMessage) => void | Promise<void>;

export type DropReason = "duplicate" | "self" | "not-owner";

export interface InboundOptions {
  /** The only Slack user whose events get past the gate. */
  ownerUserId: string;
  onMessage: MessageHandler;
  deduper?: Deduper;
}

/**
 * Installs the inbound pipeline on a Bolt app: a global gate that drops
 * duplicate deliveries, the bot's own events and anything not from the owner,
 * then listeners that turn DMs and @-mentions into {@link InboundMessage}s.
 *
 * Bolt acks Events API payloads before any middleware runs, so every event is
 * acked whether or not it gets past the gate.
 */
export function registerInbound(
  app: App,
  { ownerUserId, onMessage, deduper = new Deduper() }: InboundOptions,
): void {
  app.use(async (args) => {
    const reason = dropReason(args, ownerUserId, deduper);
    if (reason === undefined) {
      await args.next();
      return;
    }
    args.logger.debug(`slack: dropped ${describe(args)}: ${reason}`);
    // Non-event payloads (actions, commands) leave the ack to a listener,
    // and a dropped payload never reaches one.
    if ("ack" in args && typeof args.ack === "function") await args.ack();
  });

  // The same message can arrive as both `message` and `app_mention` under
  // different event_ids, so delivery is also deduplicated per message.
  const deliver = async (message: InboundMessage) => {
    if (deduper.firstSeen(`message:${message.channel}:${message.ts}`))
      await onMessage(message);
  };

  // Only DMs count as requests here. In channels the bot answers @-mentions,
  // which come through app_mention below.
  app.event("message", async ({ event, body }) => {
    // Keep the subtypes that carry something the owner typed. Edits,
    // deletions, joins and bot posts are left out.
    if (
      event.subtype !== undefined &&
      event.subtype !== "file_share" &&
      event.subtype !== "thread_broadcast"
    )
      return;
    if (event.channel_type !== "im") return;
    await deliver({
      eventId: body.event_id,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      user: event.user,
      text: event.text ?? "",
      via: "dm",
    });
  });

  app.event("app_mention", async ({ event, body, context }) => {
    if (event.user === undefined) return;
    await deliver({
      eventId: body.event_id,
      channel: event.channel,
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      user: event.user,
      text: stripMention(event.text, context.botUserId),
      via: "mention",
    });
  });
}

type GateArgs = AnyMiddlewareArgs & AllMiddlewareArgs;

function dropReason(
  args: GateArgs,
  ownerUserId: string,
  deduper: Deduper,
): DropReason | undefined {
  if ("event" in args) {
    if (!deduper.firstSeen(`event:${args.body.event_id}`)) return "duplicate";
    if (isFromSelf(args.event, args.context)) return "self";
  }
  // Bolt resolves the acting user for every payload type: event.user for
  // events, user.id for actions, user_id for commands.
  if (args.context.userId !== ownerUserId) return "not-owner";
  return undefined;
}

function isFromSelf(
  event: object,
  { botId, botUserId }: AllMiddlewareArgs["context"],
): boolean {
  const eventBotId = "bot_id" in event ? event.bot_id : undefined;
  const eventUser = "user" in event ? event.user : undefined;
  return (
    (botId !== undefined && eventBotId === botId) ||
    (botUserId !== undefined && eventUser === botUserId)
  );
}

function describe(args: GateArgs): string {
  if ("event" in args)
    return `event ${args.body.event_id} (${args.event.type})`;
  return `payload from ${args.context.userId ?? "unknown user"}`;
}

function stripMention(text: string, botUserId: string | undefined): string {
  if (botUserId === undefined) return text.trim();
  return text
    .replaceAll(new RegExp(`\\s*<@${botUserId}(\\|[^>]*)?>\\s*`, "g"), " ")
    .trim();
}
