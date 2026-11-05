import { LogLevel } from "@repo/core/slack";
import { z } from "zod";

export interface Environment {
  slackBotToken: string;
  slackAppToken: string;
  slackOwnerId: string;
  logLevel: LogLevel;
}

const requiredString = () =>
  z.string({
    error: (issue) => (issue.input === undefined ? "is not set" : undefined),
  });

const environmentSchema = z.object({
  SLACK_BOT_TOKEN: requiredString().startsWith(
    "xoxb-",
    "must be the bot token, which starts with xoxb-",
  ),
  SLACK_APP_TOKEN: requiredString().startsWith(
    "xapp-",
    "must be the app-level token, which starts with xapp-",
  ),
  SLACK_OWNER_ID: requiredString().regex(
    /^[UW][A-Z0-9]+$/,
    "must be your Slack member ID, like U0123ABCD",
  ),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
});

export const parseEnvironment = (
  variables: Record<string, string | undefined>,
): Environment => {
  const result = environmentSchema.safeParse(variables);
  if (!result.success) {
    throw new Error(
      `Invalid environment. Set these in apps/agent/.env, starting from apps/agent/.env.example:\n${z.prettifyError(result.error)}`,
    );
  }
  return {
    slackBotToken: result.data.SLACK_BOT_TOKEN,
    slackAppToken: result.data.SLACK_APP_TOKEN,
    slackOwnerId: result.data.SLACK_OWNER_ID,
    logLevel: result.data.LOG_LEVEL,
  };
};
