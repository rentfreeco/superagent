import { expect, it } from "vitest";
import type { NewTaskInput } from "../store/inputs.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { acknowledgeMessages } from "./acknowledge-messages.ts";

it("puts 👀 once on each Slack message the worker was given and hasn't finished, skipping inputs that aren't Slack messages", () => {
  const { store } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs: "100.000001",
  });
  const addMessage = (eventId: string, ts: string): NewTaskInput => {
    store.events.record({
      eventId,
      type: "app_mention",
      channel: "C0MAPPED",
      ts,
      threadTs: "100.000001",
      user: "U0OWNER",
      text: eventId,
    });
    return { taskId: task.id, source: "slack", ref: eventId, text: eventId };
  };
  const inputs = [
    addMessage("EvGiven", "100.000001"),
    addMessage("EvFinished", "100.000002"),
    addMessage("EvNotGivenYet", "100.000003"),
    { taskId: task.id, source: "system", ref: null, text: "restarted" },
    { taskId: task.id, source: "slack", ref: "EvNeverRecorded", text: "?" },
    { taskId: task.id, source: "github", ref: "review-comment-7", text: "?" },
  ] satisfies NewTaskInput[];
  const [given, finished, , restartNote, neverRecorded, reviewComment] =
    inputs.map((input) => store.inputs.add(input));
  const deliveredIds = [
    given,
    finished,
    restartNote,
    neverRecorded,
    reviewComment,
  ].map((input) => input?.id ?? 0);
  store.inputs.markDelivered(deliveredIds);
  store.inputs.markRead([finished?.id ?? 0]);

  expect(acknowledgeMessages({ store, taskId: task.id })).toBe(1);
  expect(acknowledgeMessages({ store, taskId: task.id })).toBe(0);

  expect(store.outbox.pending()).toEqual([
    expect.objectContaining({
      dedupeKey: "ack:EvGiven",
      channel: "C0MAPPED",
      threadTs: null,
      message: { kind: "reaction", name: "eyes", timestamp: "100.000001" },
    }),
  ]);
});
