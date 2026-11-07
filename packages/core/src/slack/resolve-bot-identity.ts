import type { BotIdentity } from "./thread.ts";

export interface AuthTestIdentity {
  user_id?: string | undefined;
  bot_id?: string | undefined;
}

/** The bot's identity from auth.test, refusing one that can't work with this owner. */
export const resolveBotIdentity = (
  auth: AuthTestIdentity,
  ownerUserId: string,
): BotIdentity => {
  if (auth.user_id === undefined || auth.bot_id === undefined) {
    throw new Error(
      "slack: auth.test returned no bot identity; is botToken a bot (xoxb-) token?",
    );
  }
  if (auth.user_id === ownerUserId) {
    throw new Error(
      `slack: the owner's user ID ${ownerUserId} is this bot's own, so every message from the owner would be dropped as the bot's. Use your own member ID: your avatar → Profile → ⋮ → Copy member ID.`,
    );
  }
  return { userId: auth.user_id, botId: auth.bot_id };
};
