import { App, LogLevel, type Receiver } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import type { Store } from "../store/open-store.ts";
import { openTestStore } from "../store/open-test-store.ts";
import {
  type InboundMessage,
  type InboundReaction,
  registerInbound,
} from "./inbound.ts";

const OWNER = "U_OWNER";
const BOT_USER = "U_BOT";
const BOT_ID = "B_BOT";

// Events are fed straight into Bolt's processEvent, so these tests exercise
// Bolt's own ack and dispatch rather than a stand-in for them. Passing an
// existing store in simulates a restart: a fresh app over the same state.
function setup(store: Store = openTestStore().store) {
  const receiver: Receiver = {
    init: () => {},
    start: async () => {},
    stop: async () => {},
  };
  const app = new App({
    token: "xoxb-test",
    botId: BOT_ID,
    botUserId: BOT_USER,
    receiver,
    ignoreSelf: false,
    convoStore: false,
    logLevel: LogLevel.ERROR,
  });
  const received: InboundMessage[] = [];
  const reactions: InboundReaction[] = [];
  const followedThreads = new Set(["C1:200.000001"]);
  registerInbound(app, {
    ownerUserId: OWNER,
    onMessage: (message) => void received.push(message),
    onReaction: (reaction) => void reactions.push(reaction),
    isFollowedThread: (channel, threadTs) =>
      followedThreads.has(`${channel}:${threadTs}`),
    eventLog: store.events,
  });

  const send = async (body: Record<string, unknown>) => {
    const ack = vi.fn(async () => {});
    await app.processEvent({ body, ack });
    return ack;
  };
  return { app, reactions, received, send, store };
}

let nextEventId = 0;
function envelope(
  event: Record<string, unknown>,
  eventId = `Ev${++nextEventId}`,
) {
  return {
    type: "event_callback",
    token: "t",
    team_id: "T1",
    api_app_id: "A1",
    event_id: eventId,
    event_time: 0,
    event,
  };
}

function dm(fields: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "D1",
    channel_type: "im",
    user: OWNER,
    text: "fix the flaky test",
    ts: "100.000001",
    event_ts: "100.000001",
    ...fields,
  };
}

function mention(fields: Record<string, unknown> = {}) {
  return {
    type: "app_mention",
    channel: "C1",
    user: OWNER,
    text: `<@${BOT_USER}> fix the build`,
    ts: "200.000001",
    event_ts: "200.000001",
    ...fields,
  };
}

function channelReply(fields: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: OWNER,
    text: "also update the docs",
    ts: "200.000005",
    thread_ts: "200.000001",
    event_ts: "200.000005",
    ...fields,
  };
}

function reactionAdded(fields: Record<string, unknown> = {}) {
  return {
    type: "reaction_added",
    user: OWNER,
    reaction: "octagonal_sign",
    item: { type: "message", channel: "C1", ts: "200.000001" },
    item_user: OWNER,
    event_ts: "200.000009",
    ...fields,
  };
}

describe("registerInbound in followed threads", () => {
  it("delivers the owner's reply in a followed thread without a mention, and strips one if it has it", async () => {
    const { received, send } = setup();

    await send(envelope(channelReply(), "EvReply"));
    await send(
      envelope(
        channelReply({
          ts: "200.000006",
          text: `<@${BOT_USER}> and the changelog`,
        }),
      ),
    );

    expect(received).toEqual([
      {
        eventId: "EvReply",
        channel: "C1",
        ts: "200.000005",
        threadTs: "200.000001",
        user: OWNER,
        text: "also update the docs",
        via: "thread",
      },
      expect.objectContaining({ text: "and the changelog", via: "thread" }),
    ]);
  });

  it("ignores the owner's channel messages outside a followed thread", async () => {
    const { received, send, store } = setup();

    await send(
      envelope(
        channelReply({ thread_ts: undefined, ts: "300.000001" }),
        "EvTop",
      ),
    );
    await send(
      envelope(channelReply({ thread_ts: "300.000001" }), "EvOtherThread"),
    );

    expect(received).toEqual([]);
    expect(store.events.get("EvTop")?.disposition).toBe("ignored");
    expect(store.events.get("EvOtherThread")?.disposition).toBe("ignored");
  });

  it("drops someone else's reply in a followed thread", async () => {
    const { received, send, store } = setup();
    await send(envelope(channelReply({ user: "U_SOMEONE" }), "EvSomeone"));
    expect(received).toEqual([]);
    expect(store.events.get("EvSomeone")).toMatchObject({
      disposition: "dropped_not_owner",
      text: null,
    });
  });

  it("passes a reply on once when it arrives both as a message and as a mention", async () => {
    const { received, send, store } = setup();
    const text = `<@${BOT_USER}> also update the docs`;

    await send(envelope(channelReply({ text }), "EvAsMessage"));
    await send(
      envelope(
        mention({ ts: "200.000005", thread_ts: "200.000001", text }),
        "EvAsMention",
      ),
    );

    expect(received.map(({ eventId }) => eventId)).toEqual(["EvAsMessage"]);
    expect(store.events.get("EvAsMention")?.disposition).toBe(
      "duplicate_message",
    );
  });
});

describe("registerInbound reactions", () => {
  it("passes on the owner's reaction to a message, keeping the emoji as the event's text", async () => {
    const { reactions, send, store } = setup();

    await send(envelope(reactionAdded(), "EvStop"));

    expect(reactions).toEqual([
      {
        eventId: "EvStop",
        channel: "C1",
        ts: "200.000001",
        user: OWNER,
        reaction: "octagonal_sign",
      },
    ]);
    expect(store.events.get("EvStop")).toMatchObject({
      type: "reaction_added",
      channel: "C1",
      ts: "200.000001",
      text: "octagonal_sign",
      disposition: "received",
    });
  });

  it("drops reactions by someone else or by the bot, and ignores ones on anything but a message", async () => {
    const { reactions, send, store } = setup();

    await send(envelope(reactionAdded({ user: "U_SOMEONE" }), "EvSomeone"));
    await send(envelope(reactionAdded({ user: BOT_USER }), "EvBot"));
    await send(
      envelope(
        reactionAdded({ item: { type: "file", file: "F1" } }),
        "EvOnFile",
      ),
    );

    expect(reactions).toEqual([]);
    expect(store.events.get("EvSomeone")?.disposition).toBe(
      "dropped_not_owner",
    );
    expect(store.events.get("EvBot")?.disposition).toBe("dropped_self");
    expect(store.events.get("EvOnFile")?.disposition).toBe("ignored");
  });
});

describe("registerInbound", () => {
  it("delivers a DM from the owner, acks it, and leaves it for the app to settle", async () => {
    const { received, send, store } = setup();
    const ack = await send(envelope(dm(), "EvDM"));

    expect(ack).toHaveBeenCalledOnce();
    expect(store.events.get("EvDM")).toMatchObject({
      type: "message",
      channel: "D1",
      ts: "100.000001",
      user: OWNER,
      text: "fix the flaky test",
      disposition: "received",
    });
    expect(received).toEqual([
      {
        eventId: "EvDM",
        channel: "D1",
        ts: "100.000001",
        threadTs: "100.000001",
        user: OWNER,
        text: "fix the flaky test",
        via: "dm",
      },
    ]);
  });

  it("files a thread reply under the thread's root", async () => {
    const { received, send } = setup();
    await send(envelope(dm({ ts: "100.000002", thread_ts: "100.000001" })));
    expect(received[0]?.threadTs).toBe("100.000001");
  });

  it("keeps file shares, which are how messages with attachments arrive", async () => {
    const { received, send } = setup();
    await send(envelope(dm({ subtype: "file_share" })));
    expect(received).toHaveLength(1);
  });

  it("keeps a redelivered event from every listener but acks each delivery", async () => {
    const { app, received, send } = setup();
    const listener = vi.fn(async () => {});
    app.event("message", listener);

    const first = await send(envelope(dm(), "EvRetry"));
    const retry = await send(envelope(dm(), "EvRetry"));

    expect(first).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
  });

  it("still recognises a handled event after a restart", async () => {
    const beforeRestart = setup();
    await beforeRestart.send(envelope(dm(), "EvBeforeRestart"));

    const afterRestart = setup(beforeRestart.store);
    await afterRestart.send(envelope(dm(), "EvBeforeRestart"));

    expect(beforeRestart.received).toHaveLength(1);
    expect(afterRestart.received).toEqual([]);
  });

  it("drops the bot's own messages", async () => {
    const { received, send, store } = setup();
    const ack = await send(
      envelope(dm({ user: BOT_USER, bot_id: BOT_ID, text: "on it" }), "EvSelf"),
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
    expect(store.events.get("EvSelf")?.disposition).toBe("dropped_self");
  });

  it("drops messages from anyone but the owner, without keeping their text", async () => {
    const { received, send, store } = setup();
    const ack = await send(envelope(dm({ user: "U_SOMEONE" }), "EvSomeone"));

    expect(ack).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
    expect(store.events.get("EvSomeone")).toMatchObject({
      disposition: "dropped_not_owner",
      text: null,
    });
  });

  it("settles event types it doesn't handle as ignored", async () => {
    const { send, store } = setup();
    await send(
      envelope(
        {
          type: "member_joined_channel",
          user: OWNER,
          channel: "C1",
          event_ts: "100.000005",
        },
        "EvJoined",
      ),
    );

    expect(store.events.get("EvJoined")).toMatchObject({
      type: "member_joined_channel",
      channel: "C1",
      disposition: "ignored",
    });
  });

  it("drops edits, which carry no top-level user to check against the owner", async () => {
    const { received, send, store } = setup();
    await send(
      envelope(
        {
          type: "message",
          subtype: "message_changed",
          channel: "D1",
          channel_type: "im",
          hidden: true,
          ts: "100.000009",
          event_ts: "100.000009",
          message: {
            type: "message",
            user: OWNER,
            text: "fix the flaky tests",
            ts: "100.000001",
          },
          previous_message: {
            type: "message",
            user: OWNER,
            text: "fix the flaky test",
            ts: "100.000001",
          },
        },
        "EvEdit",
      ),
    );
    expect(received).toEqual([]);
    expect(store.events.get("EvEdit")?.disposition).toBe("dropped_not_owner");
  });

  it("ignores channel messages that don't mention the bot", async () => {
    const { received, send, store } = setup();
    await send(
      envelope(dm({ channel: "C1", channel_type: "channel" }), "EvChannel"),
    );
    expect(received).toEqual([]);
    expect(store.events.get("EvChannel")?.disposition).toBe("ignored");
  });

  it("delivers an @-mention with the mention stripped", async () => {
    const { received, send } = setup();
    await send(envelope(mention({ thread_ts: "190.000001" }), "EvMention"));

    expect(received).toEqual([
      {
        eventId: "EvMention",
        channel: "C1",
        ts: "200.000001",
        threadTs: "190.000001",
        user: OWNER,
        text: "fix the build",
        via: "mention",
      },
    ]);
  });

  it("delivers a message once when Slack sends it as both a message and an app_mention", async () => {
    const { received, send, store } = setup();
    const text = `<@${BOT_USER}> fix the build`;
    await send(envelope(dm({ text }), "EvAsMessage"));
    await send(
      envelope(
        mention({ channel: "D1", ts: "100.000001", text }),
        "EvAsMention",
      ),
    );
    expect(received).toHaveLength(1);
    expect(store.events.get("EvAsMention")?.disposition).toBe(
      "duplicate_message",
    );
  });

  it("acks and drops an interaction from someone other than the owner", async () => {
    const { send } = setup();
    const ack = await send({
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U_SOMEONE" },
      api_app_id: "A1",
      token: "t",
      trigger_id: "1.2.3",
      container: {
        type: "message",
        channel_id: "D1",
        message_ts: "100.000001",
      },
      channel: { id: "D1" },
      actions: [
        {
          type: "button",
          action_id: "approve",
          block_id: "b1",
          action_ts: "1",
        },
      ],
    });
    expect(ack).toHaveBeenCalledOnce();
  });
});
