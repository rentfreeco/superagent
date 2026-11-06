import type { InboundReaction } from "@repo/core/slack";
import { IN_MEMORY_STORE, openStore } from "@repo/core/store";
import { expect, it, vi } from "vitest";
import { createReactionHandler } from "./handle-reaction.ts";

const reaction = (fields: Partial<InboundReaction>): InboundReaction => ({
  eventId: "EvStop",
  channel: "C0123ABCD",
  ts: "100.000001",
  user: "U0OWNER",
  reaction: "octagonal_sign",
  ...fields,
});

it("stops the task whose message got 🛑, settles every reaction, and wakes the outbox and runner", () => {
  const store = openStore({ path: IN_MEMORY_STORE });
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0123ABCD",
    originTs: "100.000001",
  });
  store.tasks.transition(task.id, "running");
  store.threads.claim({
    channel: "C0123ABCD",
    threadTs: "100.000001",
    taskId: task.id,
  });
  const wakeOutbox = vi.fn();
  const wakeTaskRunner = vi.fn();
  const handleReaction = createReactionHandler({
    store,
    wakeOutbox,
    wakeTaskRunner,
  });
  for (const event of [
    reaction({}),
    reaction({ eventId: "EvEyes", reaction: "eyes" }),
  ]) {
    store.events.record({
      eventId: event.eventId,
      type: "reaction_added",
      channel: event.channel,
      ts: event.ts,
      threadTs: null,
      user: event.user,
      text: event.reaction,
    });
    handleReaction(event);
  }

  expect(store.tasks.get(task.id)?.state).toBe("stopped");
  expect(store.events.get("EvStop")?.disposition).toBe("stopped_task");
  expect(store.events.get("EvEyes")?.disposition).toBe("ignored");
  expect(wakeOutbox).toHaveBeenCalledTimes(2);
  expect(wakeTaskRunner).toHaveBeenCalledTimes(2);
});
