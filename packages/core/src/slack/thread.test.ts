import type { webApi } from "@slack/bolt";
import { expect, it, vi } from "vitest";
import { fetchThread } from "./thread.ts";

it("reads every page of a thread and flags the bot's own posts", async () => {
  const replies = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      messages: [
        { ts: "1.0", user: "U_OWNER", text: "fix the flaky test" },
        { ts: "1.1", user: "U_BOT", bot_id: "B_BOT", text: "on it" },
      ],
      response_metadata: { next_cursor: "page2" },
    })
    .mockResolvedValueOnce({
      ok: true,
      messages: [{ ts: "1.2", user: "U_OWNER", text: "also the lint" }],
      response_metadata: { next_cursor: "" },
    });
  const client = { conversations: { replies } } as unknown as webApi.WebClient;

  const messages = await fetchThread(
    client,
    { userId: "U_BOT", botId: "B_BOT" },
    "D1",
    "1.0",
  );

  expect(replies).toHaveBeenCalledTimes(2);
  expect(replies).toHaveBeenNthCalledWith(1, {
    channel: "D1",
    ts: "1.0",
    limit: 200,
    cursor: undefined,
  });
  expect(replies).toHaveBeenNthCalledWith(2, {
    channel: "D1",
    ts: "1.0",
    limit: 200,
    cursor: "page2",
  });
  expect(messages).toEqual([
    { ts: "1.0", user: "U_OWNER", text: "fix the flaky test", fromSelf: false },
    { ts: "1.1", user: "U_BOT", botId: "B_BOT", text: "on it", fromSelf: true },
    { ts: "1.2", user: "U_OWNER", text: "also the lint", fromSelf: false },
  ]);
});
