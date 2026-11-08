import { webApi } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import {
  addReaction,
  removeReaction,
  classifyDeliveryFailure,
  findOwnPost,
  OUTBOX_METADATA_EVENT_TYPE,
  postMessage,
} from "./delivery.ts";

const identity = { userId: "U0BOT", botId: "B0BOT" };

const slackPlatformError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), {
    code: webApi.ErrorCode.PlatformError,
    data: { ok: false, error: code },
  });

const ownPost = (ts: string, dedupeKey: string) => ({
  ts,
  bot_id: identity.botId,
  text: "Opened #12",
  metadata: {
    event_type: OUTBOX_METADATA_EVENT_TYPE,
    event_payload: { dedupe_key: dedupeKey },
  },
});

describe("postMessage", () => {
  it("posts into the thread with the dedupe key as metadata and returns the ts", async () => {
    const postMessageCall = vi
      .fn()
      .mockResolvedValue({ ok: true, ts: "1.0002" });
    const client = {
      chat: { postMessage: postMessageCall },
    } as unknown as webApi.WebClient;

    const ts = await postMessage(client, {
      channel: "C0123ABCD",
      threadTs: "1.0001",
      text: "Opened #12",
      dedupeKey: "report:1",
    });

    expect(ts).toBe("1.0002");
    expect(postMessageCall).toHaveBeenCalledExactlyOnceWith({
      channel: "C0123ABCD",
      thread_ts: "1.0001",
      text: "Opened #12",
      metadata: {
        event_type: OUTBOX_METADATA_EVENT_TYPE,
        event_payload: { dedupe_key: "report:1" },
      },
    });
  });

  it("refuses a response without a ts", async () => {
    const client = {
      chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    } as unknown as webApi.WebClient;
    await expect(
      postMessage(client, {
        channel: "C0123ABCD",
        threadTs: null,
        text: "hi",
        dedupeKey: "reply:Ev1",
      }),
    ).rejects.toThrow("returned no ts");
  });
});

describe("addReaction", () => {
  it("treats a reaction that is already there as added", async () => {
    const add = vi
      .fn()
      .mockRejectedValue(slackPlatformError("already_reacted"));
    const client = { reactions: { add } } as unknown as webApi.WebClient;
    await expect(
      addReaction(client, { channel: "C1", timestamp: "1.0001", name: "eyes" }),
    ).resolves.toBeUndefined();
  });

  it("passes any other error on", async () => {
    const add = vi
      .fn()
      .mockRejectedValue(slackPlatformError("message_not_found"));
    const client = { reactions: { add } } as unknown as webApi.WebClient;
    await expect(
      addReaction(client, { channel: "C1", timestamp: "1.0001", name: "eyes" }),
    ).rejects.toThrow("message_not_found");
  });
});

describe("removeReaction", () => {
  it("treats a reaction that is already gone as removed, and passes any other error on", async () => {
    const remove = vi
      .fn()
      .mockRejectedValueOnce(slackPlatformError("no_reaction"))
      .mockRejectedValueOnce(slackPlatformError("message_not_found"));
    const client = { reactions: { remove } } as unknown as webApi.WebClient;
    const reaction = { channel: "C1", timestamp: "1.0001", name: "eyes" };

    await expect(removeReaction(client, reaction)).resolves.toBeUndefined();
    await expect(removeReaction(client, reaction)).rejects.toThrow(
      "message_not_found",
    );
  });
});

describe("findOwnPost", () => {
  it("finds the bot's post with the dedupe key, paging through the thread", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: "1.0001", user: "U0OWNER", text: "fix it" },
          { ...ownPost("1.0002", "report:1"), bot_id: "B0OTHER" },
          ownPost("1.0003", "report:2"),
        ],
        response_metadata: { next_cursor: "page2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [ownPost("1.0004", "report:1")],
        response_metadata: { next_cursor: "" },
      });
    const client = {
      conversations: { replies },
    } as unknown as webApi.WebClient;

    const ts = await findOwnPost(client, identity, {
      channel: "C0123ABCD",
      threadTs: "1.0001",
      dedupeKey: "report:1",
      postedAfter: 1_700_000_000_000,
    });

    expect(ts).toBe("1.0004");
    expect(replies).toHaveBeenNthCalledWith(1, {
      channel: "C0123ABCD",
      ts: "1.0001",
      oldest: "1700000000.000000",
      include_all_metadata: true,
      limit: 200,
      cursor: undefined,
    });
    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "page2" }),
    );
  });

  it("searches channel history for a post outside any thread", async () => {
    const history = vi.fn().mockResolvedValue({
      ok: true,
      messages: [ownPost("1.0009", "reply:Ev1")],
    });
    const client = {
      conversations: { history },
    } as unknown as webApi.WebClient;

    expect(
      await findOwnPost(client, identity, {
        channel: "D0123ABCD",
        threadTs: null,
        dedupeKey: "reply:Ev1",
        postedAfter: 1_700_000_000_000,
      }),
    ).toBe("1.0009");
  });

  it("reports nothing when the post isn't there", async () => {
    const replies = vi.fn().mockResolvedValue({ ok: true, messages: [] });
    const client = {
      conversations: { replies },
    } as unknown as webApi.WebClient;
    expect(
      await findOwnPost(client, identity, {
        channel: "C0123ABCD",
        threadTs: "1.0001",
        dedupeKey: "report:1",
        postedAfter: 0,
      }),
    ).toBeUndefined();
  });
});

describe("classifyDeliveryFailure", () => {
  it("gives up on errors that retrying can't fix", () => {
    for (const code of [
      "not_in_channel",
      "channel_not_found",
      "msg_too_long",
      "invalid_auth",
    ]) {
      expect(classifyDeliveryFailure(slackPlatformError(code))).toEqual({
        kind: "permanent",
      });
    }
  });

  it("retries Slack-side errors and anything that isn't a Slack answer", () => {
    for (const error of [
      slackPlatformError("ratelimited"),
      slackPlatformError("internal_error"),
      new Error("socket hang up"),
      "not even an error",
    ]) {
      expect(classifyDeliveryFailure(error)).toEqual({
        kind: "transient",
        retryAfterMs: undefined,
      });
    }
  });

  it("passes on how long a rate limit asks the bot to wait", () => {
    expect(
      classifyDeliveryFailure(
        Object.assign(new Error("rate limited"), {
          code: webApi.ErrorCode.RateLimitedError,
          retryAfter: 30,
        }),
      ),
    ).toEqual({ kind: "transient", retryAfterMs: 30_000 });
  });
});
