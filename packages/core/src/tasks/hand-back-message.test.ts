import { describe, expect, it } from "vitest";
import type { NewEvent } from "../store/events.ts";
import type { InputSource } from "../store/inputs.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { handBackMessage } from "./hand-back-message.ts";

const setup = () => {
  const { store } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs: "100.000001",
  });
  store.tasks.transition(task.id, "running");
  const giveMessage = (
    event: Partial<NewEvent> & Pick<NewEvent, "eventId" | "ts">,
    {
      source = "slack",
      isDelivered = true,
    }: { source?: InputSource; isDelivered?: boolean } = {},
  ) => {
    store.events.record({
      type: "message",
      channel: "C0MAPPED",
      threadTs: "100.000001",
      user: "U0OWNER",
      text: "also, what's the weather like?",
      ...event,
    });
    const input = store.inputs.add({
      taskId: task.id,
      source,
      ref: event.eventId,
      text: event.text ?? "also, what's the weather like?",
    });
    if (input === undefined) throw new Error("No input added");
    if (isDelivered) store.inputs.markDelivered([input.id]);
    return input;
  };
  const handBack = (reason = "Not about the flaky test.") =>
    handBackMessage({ store, taskId: task.id, reason });
  return { giveMessage, handBack, store, task };
};

describe("handBackMessage", () => {
  it("hands the newest message the worker was given this turn back to the router, naming the task and why", () => {
    const { giveMessage, handBack, store, task } = setup();
    giveMessage({ eventId: "EvOrigin", ts: "100.000001", type: "app_mention" });
    giveMessage({ eventId: "EvEarlier", ts: "100.000002" });
    giveMessage({ eventId: "EvOffTopic", ts: "100.000003" });

    const outcome = handBack();

    expect(outcome.isAccepted).toBe(true);
    expect(store.candidates.undecided()).toEqual([
      expect.objectContaining({
        eventId: "EvOffTopic",
        channel: "C0MAPPED",
        ts: "100.000003",
        threadTs: "100.000001",
        text: "also, what's the weather like?",
        via: "thread",
        handedBackBy: task.id,
        handBackReason: "Not about the flaky test.",
      }),
    ]);
  });

  it("hands back a DM the router attached to the task, as a DM", () => {
    const { giveMessage, handBack, store } = setup();
    giveMessage(
      { eventId: "EvDm", channel: "D0OWNER", ts: "200.000001", threadTs: null },
      { source: "router" },
    );

    handBack();

    expect(store.candidates.undecided()).toEqual([
      expect.objectContaining({
        eventId: "EvDm",
        threadTs: "200.000001",
        via: "dm",
      }),
    ]);
  });

  it("refuses the request the task was started for", () => {
    const { giveMessage, handBack, store } = setup();
    giveMessage({ eventId: "EvOrigin", ts: "100.000001", type: "app_mention" });

    expect(handBack()).toMatchObject({ isAccepted: false });
    expect(store.candidates.undecided()).toEqual([]);
  });

  it("refuses when no message arrived this turn: one not yet delivered, or one an earlier turn read", () => {
    const { giveMessage, handBack, store } = setup();
    const earlier = giveMessage({ eventId: "EvRead", ts: "100.000002" });
    store.inputs.markRead([earlier.id]);
    giveMessage(
      { eventId: "EvWaiting", ts: "100.000003" },
      { isDelivered: false },
    );

    expect(handBack()).toEqual({
      isAccepted: false,
      reply: "No message from the owner arrived this turn to hand back.",
    });
  });

  it("hands a message back once", () => {
    const { giveMessage, handBack, store } = setup();
    giveMessage({ eventId: "EvOffTopic", ts: "100.000002" });

    handBack();

    expect(handBack()).toEqual({
      isAccepted: false,
      reply: "You already handed this message back.",
    });
    expect(store.candidates.undecided()).toHaveLength(1);
  });
});
