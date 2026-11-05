import { LogLevel } from "@repo/core/slack";
import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./environment.ts";

const slackVariables = {
  SLACK_BOT_TOKEN: "xoxb-1-2-3",
  SLACK_APP_TOKEN: "xapp-1-2-3",
  SLACK_OWNER_ID: "U0123ABCD",
};

describe("parseEnvironment", () => {
  it("reads the Slack settings and defaults the log level to info", () => {
    expect(parseEnvironment({ ...slackVariables, PATH: "/usr/bin" })).toEqual({
      slackBotToken: "xoxb-1-2-3",
      slackAppToken: "xapp-1-2-3",
      slackOwnerId: "U0123ABCD",
      logLevel: LogLevel.INFO,
    });
  });

  it("takes the log level from LOG_LEVEL", () => {
    expect(
      parseEnvironment({ ...slackVariables, LOG_LEVEL: "debug" }).logLevel,
    ).toBe(LogLevel.DEBUG);
  });

  it("names every variable that isn't set", () => {
    const parseEmpty = () => parseEnvironment({});
    expect(parseEmpty).toThrow(/is not set\n {2}→ at SLACK_BOT_TOKEN/);
    expect(parseEmpty).toThrow(/is not set\n {2}→ at SLACK_APP_TOKEN/);
    expect(parseEmpty).toThrow(/is not set\n {2}→ at SLACK_OWNER_ID/);
  });

  it("catches the bot and app tokens swapped", () => {
    const parseSwapped = () =>
      parseEnvironment({
        ...slackVariables,
        SLACK_BOT_TOKEN: slackVariables.SLACK_APP_TOKEN,
        SLACK_APP_TOKEN: slackVariables.SLACK_BOT_TOKEN,
      });
    expect(parseSwapped).toThrow(/must be the bot token/);
    expect(parseSwapped).toThrow(/must be the app-level token/);
  });

  it("rejects an owner ID that isn't a user", () => {
    expect(() =>
      parseEnvironment({ ...slackVariables, SLACK_OWNER_ID: "C0123ABCD" }),
    ).toThrow(/must be your Slack member ID/);
  });

  it("rejects an unknown log level", () => {
    expect(() =>
      parseEnvironment({ ...slackVariables, LOG_LEVEL: "verbose" }),
    ).toThrow(/LOG_LEVEL/);
  });
});
