import {
  App,
  type Logger,
  LogLevel,
  type Receiver,
  type webApi,
} from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import { openTestStore } from "../store/open-test-store.ts";
import {
  catchUpConversation,
  catchUpEventId,
  type CatchUpTarget,
} from "./catch-up.ts";
import { type InboundMessage, registerInbound } from "./inbound.ts";

const OWNER = "U0OWNER";
const BOT_USER = "U0BOT";
const BOT_ID = "B0BOT";

const historyMessage = (ts: string, fields: Record<string, unknown> = {}) => ({
  type: "message",
  ts,
  user: OWNER,
  text: `message at ${ts}`,
  ...fields,
});

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  getLevel: () => LogLevel.ERROR,
  setName: () => undefined,
};

// The missed messages go through Bolt's real processEvent, its default error
// handling, and the real gate, so these tests check the path live events take.
const setup = (onMessage?: (message: InboundMessage) => void) => {
  const { store } = openTestStore();
  const receiver: Receiver = {
    init: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
  const app = new App({
    token: "xoxb-test",
    botId: BOT_ID,
    botUserId: BOT_USER,
    receiver,
    ignoreSelf: false,
    convoStore: false,
    logger: silentLogger,
  });
  const received: InboundMessage[] = [];
  registerInbound(app, {
    ownerUserId: OWNER,
    onMessage: onMessage ?? ((message) => void received.push(message)),
    onReaction: () => undefined,
    isFollowedThread: (channel, threadTs) =>
      channel === "C0123ABCD" && threadTs === "300.000001",
    eventLog: store.events,
  });
  const history = vi.fn();
  const replies = vi.fn();
  const client = {
    conversations: { history, replies },
  } as unknown as webApi.WebClient;
  const catchUp = (target: CatchUpTarget) =>
    catchUpConversation(
      { client, app, ownerUserId: OWNER, botUserId: BOT_USER, teamId: "T1" },
      target,
    );
  return { catchUp, history, received, replies, store };
};

describe("catchUpConversation", () => {
  it("feeds the owner's missed DMs through the gate, oldest first", async () => {
    const { catchUp, history, received, store } = setup();
    history.mockResolvedValue({
      ok: true,
      messages: [
        historyMessage("100.000004", { user: BOT_USER, bot_id: BOT_ID }),
        historyMessage("100.000003"),
        historyMessage("100.000002", { user: "U0SOMEONE" }),
        historyMessage("100.000002"),
        historyMessage("100.000001"),
      ],
    });

    const result = await catchUp({
      channel: "D0123ABCD",
      threadTs: null,
      oldest: "100.000001",
    });

    expect(history).toHaveBeenCalledExactlyOnceWith({
      channel: "D0123ABCD",
      oldest: "100.000001",
      limit: 200,
      cursor: undefined,
    });
    expect(received.map(({ ts, via }) => ({ ts, via }))).toEqual([
      { ts: "100.000002", via: "dm" },
      { ts: "100.000003", via: "dm" },
    ]);
    expect(result).toEqual({ fed: 2, failed: 0 });
    expect(
      store.events.get(catchUpEventId("D0123ABCD", "100.000003")),
    ).toMatchObject({ type: "message", user: OWNER });
  });

  it("in a channel, feeds only the messages that mention the bot", async () => {
    const { catchUp, history, received } = setup();
    history.mockResolvedValue({
      ok: true,
      messages: [
        historyMessage("200.000003", { text: `<@${BOT_USER}> fix the build` }),
        historyMessage("200.000002", { text: "talking to someone else" }),
      ],
    });

    await catchUp({
      channel: "C0123ABCD",
      threadTs: null,
      oldest: "200.000001",
    });

    expect(received).toEqual([
      expect.objectContaining({
        ts: "200.000003",
        text: "fix the build",
        via: "mention",
      }),
    ]);
  });

  it("in a followed thread, feeds the owner's replies even without a mention, but not the thread's root", async () => {
    const { catchUp, received, replies } = setup();
    replies.mockResolvedValue({
      ok: true,
      messages: [
        historyMessage("300.000001", { thread_ts: "300.000001" }),
        historyMessage("300.000002", {
          thread_ts: "300.000001",
          text: "also update the docs",
        }),
        historyMessage("300.000003", {
          thread_ts: "300.000001",
          user: "U0SOMEONE",
        }),
      ],
    });

    await catchUp({
      channel: "C0123ABCD",
      threadTs: "300.000001",
      oldest: "300.000000",
    });

    expect(received).toEqual([
      expect.objectContaining({
        ts: "300.000002",
        threadTs: "300.000001",
        text: "also update the docs",
        via: "thread",
      }),
    ]);
  });

  it("skips a message that was already handled live", async () => {
    const { catchUp, history, received, store } = setup();
    store.events.record({
      eventId: "EvLive",
      type: "message",
      channel: "D0123ABCD",
      ts: "100.000002",
      threadTs: null,
      user: OWNER,
      text: "message at 100.000002",
    });
    store.events.claimMessage("EvLive");
    history.mockResolvedValue({
      ok: true,
      messages: [historyMessage("100.000002")],
    });

    await catchUp({
      channel: "D0123ABCD",
      threadTs: null,
      oldest: "100.000001",
    });

    expect(received).toEqual([]);
    expect(
      store.events.get(catchUpEventId("D0123ABCD", "100.000002"))?.disposition,
    ).toBe("duplicate_message");
  });

  it("reads a thread's replies and leaves out the root", async () => {
    const { catchUp, received, replies } = setup();
    replies.mockResolvedValue({
      ok: true,
      messages: [
        historyMessage("300.000001", {
          thread_ts: "300.000001",
          text: `<@${BOT_USER}> start`,
        }),
        historyMessage("300.000005", {
          thread_ts: "300.000001",
          text: `<@${BOT_USER}> also fix the lint`,
        }),
      ],
      response_metadata: { next_cursor: "" },
    });

    await catchUp({
      channel: "C0123ABCD",
      threadTs: "300.000001",
      oldest: "300.000001",
    });

    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "300.000001", oldest: "300.000001" }),
    );
    expect(received).toEqual([
      expect.objectContaining({
        ts: "300.000005",
        threadTs: "300.000001",
        text: "also fix the lint",
      }),
    ]);
  });

  it("keeps going when handling one missed message fails", async () => {
    const received: string[] = [];
    const { catchUp, history } = setup((message) => {
      if (message.ts === "100.000002") throw new Error("handler failed");
      received.push(message.ts);
    });
    history.mockResolvedValue({
      ok: true,
      messages: [historyMessage("100.000003"), historyMessage("100.000002")],
    });

    const result = await catchUp({
      channel: "D0123ABCD",
      threadTs: null,
      oldest: "100.000001",
    });

    expect(received).toEqual(["100.000003"]);
    expect(result).toEqual({ fed: 1, failed: 1 });
  });
});
