import { describe, expect, it } from "vitest";
import { openTestStore } from "../store/open-test-store.ts";
import {
  type InboundMessage,
  replayEvent,
  type SlackEventRecord,
} from "./inbound.ts";

const OWNER = "U0OWNER";
const BOT_USER = "U0BOT";

const setup = () => {
  const { store } = openTestStore();
  const received: InboundMessage[] = [];
  const options = {
    ownerUserId: OWNER,
    botUserId: BOT_USER,
    eventLog: store.events,
    onMessage: (message: InboundMessage) => void received.push(message),
  };
  const recordEvent = (fields: Partial<SlackEventRecord>): SlackEventRecord => {
    const event: SlackEventRecord = {
      eventId: "Ev1",
      type: "message",
      channel: "D0123ABCD",
      ts: "100.000001",
      threadTs: null,
      user: OWNER,
      text: "fix the flaky test",
      ...fields,
    };
    store.events.record(event);
    return event;
  };
  return { options, received, recordEvent, store };
};

describe("replayEvent", () => {
  it("delivers an @-mention the handler never finished, with the mention stripped", async () => {
    const { options, received, recordEvent, store } = setup();
    const event = recordEvent({
      type: "app_mention",
      channel: "C0123ABCD",
      threadTs: "90.000001",
      text: `<@${BOT_USER}> fix the build`,
    });
    store.events.claimMessage(event.eventId);

    await replayEvent(event, options);

    expect(received).toEqual([
      {
        eventId: "Ev1",
        channel: "C0123ABCD",
        ts: "100.000001",
        threadTs: "90.000001",
        user: OWNER,
        text: "fix the build",
        via: "mention",
      },
    ]);
  });

  it("delivers a DM the gate recorded but never got to", async () => {
    const { options, received, recordEvent } = setup();
    await replayEvent(recordEvent({}), options);
    expect(received).toEqual([
      expect.objectContaining({
        eventId: "Ev1",
        threadTs: "100.000001",
        text: "fix the flaky test",
        via: "dm",
      }),
    ]);
  });

  it.each([
    {
      name: "the bot's own message",
      fields: { user: BOT_USER },
      disposition: "dropped_self",
    },
    {
      name: "someone else's message",
      fields: { user: "U0SOMEONE" },
      disposition: "dropped_not_owner",
    },
    {
      name: "an edit, which has no top-level user",
      fields: { user: null },
      disposition: "dropped_not_owner",
    },
    {
      name: "a channel message without a mention",
      fields: { channel: "C0123ABCD" },
      disposition: "ignored",
    },
    {
      name: "an event type the gate doesn't handle",
      fields: { type: "reaction_added" },
      disposition: "ignored",
    },
    {
      name: "an event with no message ts",
      fields: { ts: null },
      disposition: "ignored",
    },
  ])("settles $name as $disposition", async ({ fields, disposition }) => {
    const { options, received, recordEvent, store } = setup();
    await replayEvent(recordEvent(fields), options);
    expect(received).toEqual([]);
    expect(store.events.get("Ev1")?.disposition).toBe(disposition);
  });

  it("doesn't deliver a message another event already claimed", async () => {
    const { options, received, recordEvent, store } = setup();
    recordEvent({ eventId: "EvAsMessage" });
    store.events.claimMessage("EvAsMessage");
    const mention = recordEvent({
      eventId: "EvAsMention",
      type: "app_mention",
      text: `<@${BOT_USER}> fix the flaky test`,
    });

    await replayEvent(mention, options);

    expect(received).toEqual([]);
    expect(store.events.get("EvAsMention")?.disposition).toBe(
      "duplicate_message",
    );
  });
});
