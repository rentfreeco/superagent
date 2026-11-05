import { App, type LogLevel, webApi } from "@slack/bolt";
import { type MessageHandler, registerInbound } from "./inbound.ts";
import { type BotIdentity, fetchThread, type ThreadMessage } from "./thread.ts";

export interface SlackGatewayOptions {
  /** Bot token (xoxb-…). */
  botToken: string;
  /** App-level token (xapp-…) with connections:write, which Socket Mode connects with. */
  appToken: string;
  /** The only Slack user the bot listens to. */
  ownerUserId: string;
  onMessage: MessageHandler;
  logLevel?: LogLevel;
}

/** The bot's Socket Mode connection to Slack. */
export class SlackGateway {
  readonly app: App;
  readonly identity: BotIdentity;

  private constructor(app: App, identity: BotIdentity) {
    this.app = app;
    this.identity = identity;
  }

  /** Resolves the bot's identity, installs the inbound pipeline and opens the connection. */
  static async connect({
    botToken,
    appToken,
    ownerUserId,
    onMessage,
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
    registerInbound(app, { ownerUserId, onMessage });
    await app.start();
    return new SlackGateway(app, identity);
  }

  /** Reads a thread's full history from Slack. Nothing is cached, so each call reflects the thread as it is now. */
  fetchThread(channel: string, threadTs: string): Promise<ThreadMessage[]> {
    return fetchThread(this.app.client, this.identity, channel, threadTs);
  }

  async close(): Promise<void> {
    await this.app.stop();
  }
}
