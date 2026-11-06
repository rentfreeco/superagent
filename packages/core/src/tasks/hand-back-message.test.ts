import { describe, expect, it } from "vitest";
import type { NewEvent } from "../store/events.ts";
import type { InputSource } from "../store/inputs.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { handBackMessage } from "./hand-back-message.ts";

const setup = () => {
  const { store } = openTestStore();
  const createTask = (originTs = "100.000001") => {
    const task = store.tasks.create({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs,
    });
    store.tasks.transition(task.id, "running");
    return task;
  };
  const task = createTask();
  const giveMessage = (
    event: Partial<NewEvent> & Pick<NewEvent, "eventId" | "ts">,
    {
      taskId = task.id,
      source = "slack",
      isDelivered = true,
    }: { taskId?: string; source?: InputSource; isDelivered?: boolean } = {},
  ) => {
    store.events.record({
      type: "message",
      channel: "C0MAPPED",
      threadTs: "100.000001",
      user: "U0OWNER",
      text: "also, what's on my calendar?",
      ...event,
    });
    const input = store.inputs.add({
      taskId,
      source,
      ref: event.eventId,
      text: event.text ?? "also, what's on my calendar?",
    });
    if (input === undefined) throw new Error("No input added");
    if (isDelivered) store.inputs.markDelivered([input.id]);
    return input;
  };
  const origin = giveMessage({
    eventId: "EvOrigin",
    ts: "100.000001",
    threadTs: null,
    type: "app_mention",
    text: "fix the flaky test",
  });
  const handBack = (inputId: number, reason = "Not about the flaky test.") =>
    handBackMessage({ store, taskId: task.id, inputId, reason });
  return { createTask, giveMessage, handBack, origin, store, task };
};

describe("handBackMessage", () => {
  it("hands the message the worker names back to the router, even when a newer one arrived since", () => {
    const { giveMessage, handBack, store, task } = setup();
    const offTopic = giveMessage({ eventId: "EvOffTopic", ts: "100.000002" });
    giveMessage({
      eventId: "EvOnTopic",
      ts: "100.000003",
      text: "also fix the lint",
    });

    const outcome = handBack(offTopic.id);

    expect(outcome.isAccepted).toBe(true);
    expect(store.candidates.undecided()).toEqual([
      expect.objectContaining({
        eventId: "EvOffTopic",
        channel: "C0MAPPED",
        ts: "100.000002",
        threadTs: "100.000001",
        text: "also, what's on my calendar?",
        via: "thread",
        handedBackBy: task.id,
        handBackReason: "Not about the flaky test.",
      }),
    ]);
  });

  it("hands back a DM the router attached to the task, as a DM", () => {
    const { giveMessage, handBack, store } = setup();
    const attached = giveMessage(
      { eventId: "EvDm", channel: "D0OWNER", ts: "200.000001", threadTs: null },
      { source: "router" },
    );

    handBack(attached.id);

    expect(store.candidates.undecided()).toEqual([
      expect.objectContaining({
        eventId: "EvDm",
        threadTs: "200.000001",
        via: "dm",
      }),
    ]);
  });

  it("refuses the request the task was started for, even a mention inside an existing thread", () => {
    const { createTask, giveMessage, handBack, origin, store } = setup();
    const threadTask = createTask("300.000001");
    const reply = giveMessage(
      {
        eventId: "EvReplyMention",
        ts: "300.000005",
        threadTs: "300.000001",
        type: "app_mention",
      },
      { taskId: threadTask.id },
    );

    expect(handBack(origin.id).isAccepted).toBe(false);
    expect(
      handBackMessage({
        store,
        taskId: threadTask.id,
        inputId: reply.id,
        reason: "Can't do it.",
      }),
    ).toEqual({
      isAccepted: false,
      reply:
        "That is the request this task was started for, so it can't be handed back. If it can't be done here, report failed with why.",
    });
    expect(store.candidates.undecided()).toEqual([]);
  });

  it("refuses a message the worker wasn't given, one of another task's, and one that isn't from Slack", () => {
    const { createTask, giveMessage, handBack, store, task } = setup();
    const waiting = giveMessage(
      { eventId: "EvWaiting", ts: "100.000002" },
      { isDelivered: false },
    );
    const otherTask = createTask("400.000001");
    const elsewhere = giveMessage(
      { eventId: "EvElsewhere", ts: "400.000002", threadTs: "400.000001" },
      { taskId: otherTask.id },
    );
    const notice = store.inputs.add({
      taskId: task.id,
      source: "system",
      ref: null,
      text: "superagent restarted",
    });
    store.inputs.markDelivered([notice?.id ?? 0]);

    expect(handBack(waiting.id).reply).toBe(
      `You haven't been given a message ${waiting.id}.`,
    );
    expect(handBack(elsewhere.id).reply).toBe(
      `You haven't been given a message ${elsewhere.id}.`,
    );
    expect(handBack(notice?.id ?? 0).reply).toBe(
      `Message ${notice?.id} isn't a Slack message from the owner, so it can't be handed back.`,
    );
    expect(store.candidates.undecided()).toEqual([]);
  });

  it("hands a message back once", () => {
    const { giveMessage, handBack, store } = setup();
    const offTopic = giveMessage({ eventId: "EvOffTopic", ts: "100.000002" });

    handBack(offTopic.id);

    expect(handBack(offTopic.id)).toEqual({
      isAccepted: false,
      reply: `You already handed message ${offTopic.id} back.`,
    });
    expect(store.candidates.undecided()).toHaveLength(1);
  });
});
