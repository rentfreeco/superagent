import { describe, expect, it } from "vitest";
import type { InboundReaction } from "../slack/inbound.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { takeReaction } from "./take-reaction.ts";

const stopReaction = (fields: Partial<InboundReaction>): InboundReaction => ({
  eventId: "EvStop",
  channel: "C0MAPPED",
  ts: "100.000001",
  user: "U0OWNER",
  reaction: "octagonal_sign",
  ...fields,
});

const setup = () => {
  const { store } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs: "100.000001",
  });
  store.tasks.transition(task.id, "running");
  store.threads.claim({
    channel: "C0MAPPED",
    threadTs: "100.000001",
    taskId: task.id,
  });
  const queuedPosts = () =>
    store.outbox.pending().map(({ dedupeKey, threadTs, message }) => ({
      dedupeKey,
      threadTs,
      message,
    }));
  return { queuedPosts, store, task };
};

describe("takeReaction", () => {
  it("stops the task when 🛑 goes on its first message, and confirms in the thread", () => {
    const { queuedPosts, store, task } = setup();

    expect(takeReaction({ reaction: stopReaction({}), store })).toBe(
      "stopped_task",
    );

    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(queuedPosts()).toEqual([
      {
        dedupeKey: "stop:EvStop",
        threadTs: "100.000001",
        message: { kind: "post", text: "Stopped before any work started." },
      },
    ]);
  });

  it("stops the task when 🛑 goes on one of the owner's replies in its thread", () => {
    const { store, task } = setup();
    store.events.record({
      eventId: "EvReply",
      type: "message",
      channel: "C0MAPPED",
      ts: "100.000005",
      threadTs: "100.000001",
      user: "U0OWNER",
      text: "also the docs",
    });
    store.events.claimMessage("EvReply");

    expect(
      takeReaction({ reaction: stopReaction({ ts: "100.000005" }), store }),
    ).toBe("stopped_task");
    expect(store.tasks.get(task.id)?.state).toBe("stopped");
  });

  it("ignores any other emoji, and 🛑 on a message no task's thread holds", () => {
    const { queuedPosts, store, task } = setup();

    expect(
      takeReaction({ reaction: stopReaction({ reaction: "eyes" }), store }),
    ).toBe("ignored");
    expect(
      takeReaction({ reaction: stopReaction({ ts: "200.000001" }), store }),
    ).toBe("ignored");

    expect(store.tasks.get(task.id)?.state).toBe("running");
    expect(queuedPosts()).toEqual([]);
  });
});
