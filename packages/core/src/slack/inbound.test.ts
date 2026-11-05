import { App, LogLevel, type Receiver } from "@slack/bolt";
import { describe, expect, it, vi } from "vitest";
import { type InboundMessage, registerInbound } from "./inbound.ts";

const OWNER = "U_OWNER";
const BOT_USER = "U_BOT";
const BOT_ID = "B_BOT";

// Events are fed straight into Bolt's processEvent, so these tests exercise
// Bolt's own ack and dispatch rather than a stand-in for them.
function setup() {
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
  registerInbound(app, {
    ownerUserId: OWNER,
    onMessage: (message) => void received.push(message),
  });

  const send = async (body: Record<string, unknown>) => {
    const ack = vi.fn(async () => {});
    await app.processEvent({ body, ack });
    return ack;
  };
  return { app, received, send };
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

describe("registerInbound", () => {
  it("delivers a DM from the owner and acks it", async () => {
    const { received, send } = setup();
    const ack = await send(envelope(dm(), "EvDM"));

    expect(ack).toHaveBeenCalledOnce();
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
    const { app, send } = setup();
    const listener = vi.fn(async () => {});
    app.event("reaction_added", listener);
    const reaction = {
      type: "reaction_added",
      user: OWNER,
      reaction: "eyes",
      item: { type: "message", channel: "D1", ts: "100.000001" },
      event_ts: "100.000005",
    };

    const first = await send(envelope(reaction, "EvRetry"));
    const retry = await send(envelope(reaction, "EvRetry"));

    expect(first).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("drops the bot's own messages", async () => {
    const { received, send } = setup();
    const ack = await send(
      envelope(dm({ user: BOT_USER, bot_id: BOT_ID, text: "on it" })),
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
  });

  it("drops messages from anyone but the owner", async () => {
    const { received, send } = setup();
    const ack = await send(envelope(dm({ user: "U_SOMEONE" })));

    expect(ack).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
  });

  it("ignores edits", async () => {
    const { received, send } = setup();
    await send(
      envelope({
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
      }),
    );
    expect(received).toEqual([]);
  });

  it("ignores channel messages that don't mention the bot", async () => {
    const { received, send } = setup();
    await send(envelope(dm({ channel: "C1", channel_type: "channel" })));
    expect(received).toEqual([]);
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
    const { received, send } = setup();
    const text = `<@${BOT_USER}> fix the build`;
    await send(envelope(dm({ text })));
    await send(envelope(mention({ channel: "D1", ts: "100.000001", text })));
    expect(received).toHaveLength(1);
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
