import type { AllMiddlewareArgs, AnyMiddlewareArgs, App } from "@slack/bolt";
import { readStringField } from "../utils/read-string-field.ts";

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

/** What the gate records about a Slack event when it first arrives. */
export interface SlackEventRecord {
  eventId: string;
  type: string;
  channel: string | null;
  ts: string | null;
  threadTs: string | null;
  user: string | null;
  text: string | null;
}

/** How the gate settles an event it doesn't pass on. */
export type GateDisposition =
  "dropped_self" | "dropped_not_owner" | "ignored" | "duplicate_message";

/** Where the gate keeps the events it has seen, so dedupe survives a restart. */
export interface EventLog {
  record(event: SlackEventRecord): boolean;
  claimMessage(eventId: string): boolean;
  setDisposition(eventId: string, disposition: GateDisposition): void;
}

export interface InboundOptions {
  /** The only Slack user whose events get past the gate. */
  ownerUserId: string;
  onMessage: MessageHandler;
  eventLog: EventLog;
}

const HANDLED_EVENT_TYPES = new Set(["message", "app_mention"]);

/**
 * Installs the inbound pipeline on a Bolt app: a global gate that records
 * every event once, drops redeliveries, the bot's own events and anything not
 * from the owner, then listeners that turn DMs and @-mentions into
 * {@link InboundMessage}s.
 *
 * Bolt acks Events API payloads before any middleware runs, so every event is
 * acked whether or not it gets past the gate.
 */
export function registerInbound(
  app: App,
  { ownerUserId, onMessage, eventLog }: InboundOptions,
): void {
  app.use(async (args) => {
    if ("event" in args) {
      const eventId = args.body.event_id;
      if (!eventLog.record(describeEvent(eventId, args.event))) {
        args.logger.debug(`slack: dropped ${describe(args)}: duplicate`);
        return;
      }
      const disposition = gateDisposition(args, ownerUserId);
      if (disposition !== undefined) {
        eventLog.setDisposition(eventId, disposition);
        args.logger.debug(`slack: dropped ${describe(args)}: ${disposition}`);
        return;
      }
      await args.next();
      return;
    }
    // Bolt resolves the acting user for every payload type: user.id for
    // actions, user_id for commands.
    if (args.context.userId === ownerUserId) {
      await args.next();
      return;
    }
    args.logger.debug(`slack: dropped ${describe(args)}: not the owner`);
    // Non-event payloads leave the ack to a listener, and a dropped payload
    // never reaches one.
    if ("ack" in args && typeof args.ack === "function") await args.ack();
  });

  const deliver = (message: InboundMessage) =>
    deliverMessage(message, { eventLog, onMessage });

  // Only DMs count as requests here. In channels the bot answers @-mentions,
  // which come through app_mention below.
  app.event("message", async ({ event, body }) => {
    // Keep the subtypes that carry something the owner typed. Edits,
    // deletions, joins and bot posts are left out.
    if (
      (event.subtype !== undefined &&
        event.subtype !== "file_share" &&
        event.subtype !== "thread_broadcast") ||
      event.channel_type !== "im"
    ) {
      eventLog.setDisposition(body.event_id, "ignored");
      return;
    }
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
    if (event.user === undefined) {
      eventLog.setDisposition(body.event_id, "ignored");
      return;
    }
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

// The same message can arrive as both `message` and `app_mention` under
// different event_ids, or again from catch-up, so only the first event to claim
// it is delivered.
async function deliverMessage(
  message: InboundMessage,
  { eventLog, onMessage }: Pick<InboundOptions, "eventLog" | "onMessage">,
): Promise<void> {
  if (!eventLog.claimMessage(message.eventId)) {
    eventLog.setDisposition(message.eventId, "duplicate_message");
    return;
  }
  await onMessage(message);
}

export interface ReplayOptions extends InboundOptions {
  botUserId: string;
}

/**
 * Runs an event the gate recorded but never settled back through the same
 * checks, from the fields the event log kept, and delivers it if it passes.
 * The log doesn't keep a message's subtype or channel_type, so a DM is
 * recognised by its D channel ID, and an edit or deletion fails the owner
 * check because it has no top-level user.
 */
export async function replayEvent(
  event: SlackEventRecord,
  { ownerUserId, botUserId, onMessage, eventLog }: ReplayOptions,
): Promise<void> {
  const settle = (disposition: GateDisposition) =>
    eventLog.setDisposition(event.eventId, disposition);
  if (event.user === botUserId) return settle("dropped_self");
  if (event.user !== ownerUserId) return settle("dropped_not_owner");
  const { channel, ts, user } = event;
  if (channel === null || ts === null) return settle("ignored");
  const message = {
    eventId: event.eventId,
    channel,
    ts,
    threadTs: event.threadTs ?? ts,
    user,
  };
  if (event.type === "app_mention") {
    await deliverMessage(
      {
        ...message,
        text: stripMention(event.text ?? "", botUserId),
        via: "mention",
      },
      { eventLog, onMessage },
    );
    return;
  }
  if (event.type === "message" && channel.startsWith("D")) {
    await deliverMessage(
      { ...message, text: event.text ?? "", via: "dm" },
      { eventLog, onMessage },
    );
    return;
  }
  settle("ignored");
}

type GateArgs = AnyMiddlewareArgs & AllMiddlewareArgs;

function gateDisposition(
  args: Extract<GateArgs, { event: unknown }>,
  ownerUserId: string,
): GateDisposition | undefined {
  if (isFromSelf(args.event, args.context)) return "dropped_self";
  // For events, Bolt resolves the acting user from event.user.
  if (args.context.userId !== ownerUserId) return "dropped_not_owner";
  if (!HANDLED_EVENT_TYPES.has(args.event.type)) return "ignored";
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

function describeEvent(eventId: string, event: object): SlackEventRecord {
  const item = readObject(event, "item");
  return {
    eventId,
    type: readStringField(event, "type") ?? "unknown",
    channel:
      readStringField(event, "channel") ??
      readStringField(item, "channel") ??
      null,
    ts: readStringField(event, "ts") ?? readStringField(item, "ts") ?? null,
    threadTs: readStringField(event, "thread_ts") ?? null,
    user: readStringField(event, "user") ?? null,
    text: readStringField(event, "text") ?? null,
  };
}

function readObject(source: object, key: string): object {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "object" && value !== null ? value : {};
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
