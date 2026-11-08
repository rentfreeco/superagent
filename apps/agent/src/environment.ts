import { homedir } from "node:os";
import path from "node:path";
import { LogLevel } from "@repo/core/slack";
import { z } from "zod";
import { CLAUDE_DIRECTORY_NAME } from "./constants.ts";

export interface Environment {
  slackBotToken: string;
  slackAppToken: string;
  slackOwnerId: string;
  logLevel: LogLevel;
  dataDirectory: string;
  workerSandbox: boolean;
  router: boolean;
  /** The agent's own GitHub account; unset leaves workers on the machine's GitHub logins. */
  gitHub: GitHubSettings | undefined;
}

export interface GitHubSettings {
  token: string;
  ownerLogin: string;
}

const requiredString = () =>
  z.string({
    error: (issue) => (issue.input === undefined ? "is not set" : undefined),
  });

const environmentSchema = z
  .object({
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
    SUPERAGENT_DATA_DIR: z
      .string()
      .min(1, "must be a directory path; leave it unset to use ~/.superagent")
      .refine(
        (directory) =>
          !path
            .resolve(directory)
            .split(path.sep)
            .includes(CLAUDE_DIRECTORY_NAME),
        `must not be inside a ${CLAUDE_DIRECTORY_NAME} directory: Claude Code refuses workers' file edits there, so every task would end blocked`,
      )
      .default(path.join(homedir(), ".superagent")),
    SUPERAGENT_ROUTER: z
      .enum(["on", "off"], { error: "must be on or off" })
      .default("on"),
    SUPERAGENT_WORKER_SANDBOX: z
      .enum(["on", "off"], { error: "must be on or off" })
      .default("off"),
    SUPERAGENT_GITHUB_TOKEN: z
      .string()
      .min(
        1,
        "must be the agent account's token; leave it unset to use the machine's GitHub logins",
      )
      .optional(),
    SUPERAGENT_OWNER_GITHUB: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/, "must be your GitHub login, like octocat")
      .optional(),
  })
  .refine(
    (variables) =>
      variables.SUPERAGENT_GITHUB_TOKEN === undefined ||
      variables.SUPERAGENT_OWNER_GITHUB !== undefined,
    {
      message:
        "must be set with SUPERAGENT_GITHUB_TOKEN: superagent needs your GitHub login to tell your comments from its own",
      path: ["SUPERAGENT_OWNER_GITHUB"],
    },
  );

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
    dataDirectory: path.resolve(result.data.SUPERAGENT_DATA_DIR),
    workerSandbox: result.data.SUPERAGENT_WORKER_SANDBOX === "on",
    router: result.data.SUPERAGENT_ROUTER === "on",
    gitHub:
      result.data.SUPERAGENT_GITHUB_TOKEN === undefined ||
      result.data.SUPERAGENT_OWNER_GITHUB === undefined
        ? undefined
        : {
            token: result.data.SUPERAGENT_GITHUB_TOKEN,
            ownerLogin: result.data.SUPERAGENT_OWNER_GITHUB,
          },
  };
};
