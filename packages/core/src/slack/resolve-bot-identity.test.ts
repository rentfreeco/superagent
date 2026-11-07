import { describe, expect, it } from "vitest";
import { resolveBotIdentity } from "./resolve-bot-identity.ts";

describe("resolveBotIdentity", () => {
  it("returns the bot's user and bot IDs", () => {
    expect(
      resolveBotIdentity({ user_id: "U0BOT", bot_id: "B0BOT" }, "U0OWNER"),
    ).toEqual({ userId: "U0BOT", botId: "B0BOT" });
  });

  it("refuses a token without a bot identity", () => {
    expect(() => resolveBotIdentity({ user_id: "U0OWNER" }, "U0OWNER")).toThrow(
      /no bot identity/,
    );
  });

  it("refuses an owner ID that is the bot's own, which would drop every owner message", () => {
    expect(() =>
      resolveBotIdentity({ user_id: "U0BOT", bot_id: "B0BOT" }, "U0BOT"),
    ).toThrow(/U0BOT is this bot's own/);
  });
});
