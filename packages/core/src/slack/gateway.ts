import { App, type LogLevel, webApi } from "@slack/bolt";
import { SLACK_DELIVERY_TIMEOUT_MS } from "../constants.ts";
import {
  addReaction,
  classifyDeliveryFailure,
  type DeliveryFailure,
  findOwnPost,
  postMessage,
  type SlackPost,
  type SlackPostQuery,
  type SlackReaction,
} from "./delivery.ts";
import {
  type EventLog,
  type InboundMessage,
  registerInbound,
} from "./inbound.ts";
import { type BotIdentity, fetchThread, type ThreadMessage } from "./thread.ts";

export type SlackMessageHandler = (
  message: InboundMessage,
  slack: SlackGateway,
) => void | Promise<void>;

export interface SlackGatewayOptions {
  /** Bot token (xoxb-…). */
  botToken: string;
  /** App-level token (xapp-…) with connections:write, which Socket Mode connects with. */
  appToken: string;
  /** The only Slack user the bot listens to. */
  ownerUserId: string;
  onMessage: SlackMessageHandler;
  /** Where the gate records every event it sees, such as the store's events table. */
  eventLog: EventLog;
  logLevel?: LogLevel;
}

/** The bot's Socket Mode connection to Slack. */
export class SlackGateway {
  readonly app: App;
  readonly identity: BotIdentity;
  // Delivery fails fast and leaves retrying to the outbox. The default client
  // retries for about half an hour and never times out, which would stall
  // every entry queued behind one post.
  readonly #deliveryClient: webApi.WebClient;

  private constructor(
    app: App,
    identity: BotIdentity,
    deliveryClient: webApi.WebClient,
  ) {
    this.app = app;
    this.identity = identity;
    this.#deliveryClient = deliveryClient;
  }

  /** Resolves the bot's identity, installs the inbound pipeline and opens the connection. */
  static async connect({
    botToken,
    appToken,
    ownerUserId,
    onMessage,
    eventLog,
    logLevel,
  }: SlackGatewayOptions): Promise<SlackGateway> {
    const auth = await new webApi.WebClient(botToken).auth.test();
    if (auth.user_id === undefined || auth.bot_id === undefined) {
      throw new Error(
        "slack: auth.test returned no bot identity; is botToken a bot (xoxb-) token?",
      );
    }
    const identity: BotIdentity = { userId: auth.user_id, botId: auth.bot_id };

    const app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      // Handing Bolt the identity skips its own auth.test and keeps one source of truth.
      botId: identity.botId,
      botUserId: identity.userId,
      // The inbound gate drops the bot's own events itself.
      ignoreSelf: false,
      convoStore: false,
      logLevel,
    });
    const deliveryClient = new webApi.WebClient(botToken, {
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout: SLACK_DELIVERY_TIMEOUT_MS,
      logLevel,
    });
    const gateway = new SlackGateway(app, identity, deliveryClient);
    registerInbound(app, {
      ownerUserId,
      onMessage: (message) => onMessage(message, gateway),
      eventLog,
    });
    await app.start();
    return gateway;
  }

  /** Reads a thread's full history from Slack. Nothing is cached, so each call reflects the thread as it is now. */
  fetchThread(channel: string, threadTs: string): Promise<ThreadMessage[]> {
    return fetchThread(this.app.client, this.identity, channel, threadTs);
  }

  /** Posts a message carrying its outbox dedupe key as metadata, and returns its ts. */
  post(post: SlackPost): Promise<string> {
    return postMessage(this.#deliveryClient, post);
  }

  react(reaction: SlackReaction): Promise<void> {
    return addReaction(this.#deliveryClient, reaction);
  }

  /** Finds this bot's post with the given dedupe key, so a retry can tell whether an earlier attempt got through. */
  findPost(query: SlackPostQuery): Promise<string | undefined> {
    return findOwnPost(this.#deliveryClient, this.identity, query);
  }

  classifyFailure(error: unknown): DeliveryFailure {
    return classifyDeliveryFailure(error);
  }

  async close(): Promise<void> {
    await this.app.stop();
  }
}
