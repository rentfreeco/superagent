import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../slack/inbound.ts";
import { openTestStore } from "../store/open-test-store.ts";
import type { TaskState } from "../store/tasks.ts";
import { takeFollowUp } from "./take-follow-up.ts";

const followUpMessage = (fields: Partial<InboundMessage>): InboundMessage => ({
  eventId: "EvFollowUp",
  channel: "C0MAPPED",
  ts: "100.000005",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "also fix the lint",
  via: "mention",
  ...fields,
});

const setup = (state: TaskState = "running") => {
  const { store } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs: "100.000001",
  });
  if (state !== "queued") store.tasks.transition(task.id, "running");
  if (state !== "queued" && state !== "running") {
    store.tasks.transition(task.id, state);
  }
  const queuedMessages = () =>
    store.outbox.pending().map(({ dedupeKey, threadTs, message }) => ({
      dedupeKey,
      threadTs,
      message,
    }));
  return { queuedMessages, store, task };
};

describe("takeFollowUp", () => {
  it("gives the task the message as an input and puts 👀 on it", () => {
    const { queuedMessages, store, task } = setup();

    expect(
      takeFollowUp({ message: followUpMessage({}), taskId: task.id, store }),
    ).toBe("task_input");

    expect(store.inputs.undelivered(task.id)).toEqual([
      expect.objectContaining({
        source: "slack",
        ref: "EvFollowUp",
        text: "also fix the lint",
      }),
    ]);
    expect(queuedMessages()).toEqual([
      {
        dedupeKey: "ack:EvFollowUp",
        threadTs: null,
        message: { kind: "reaction", name: "eyes", timestamp: "100.000005" },
      },
    ]);
  });

  it("stops the task on the word stop alone, drops what the worker hasn't read, and confirms in the thread", () => {
    const { queuedMessages, store, task } = setup();
    store.tasks.update(task.id, { branch: `agent/${task.id}` });
    store.inputs.add({
      taskId: task.id,
      source: "slack",
      ref: "EvEarlier",
      text: "and the docs",
    });

    expect(
      takeFollowUp({
        message: followUpMessage({ text: "  Stop. " }),
        taskId: task.id,
        store,
      }),
    ).toBe("stopped_task");

    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(store.inputs.unread(task.id)).toEqual([]);
    expect(store.inputs.tasksWithUndelivered()).toEqual([]);
    expect(queuedMessages()).toEqual([
      {
        dedupeKey: "stop:EvFollowUp",
        threadTs: "100.000001",
        message: {
          kind: "post",
          text: `Stopped. The branch \`agent/${task.id}\` is kept.`,
        },
      },
    ]);
  });

  it("says so when stopping a task that never got a branch", () => {
    const { queuedMessages, store, task } = setup("queued");
    takeFollowUp({
      message: followUpMessage({ text: "stop" }),
      taskId: task.id,
      store,
    });
    expect(queuedMessages()[0]?.message).toEqual({
      kind: "post",
      text: "Stopped before any work started.",
    });
  });

  it("leaves a task that has already ended as it is", () => {
    const { queuedMessages, store, task } = setup("done");

    takeFollowUp({
      message: followUpMessage({ text: "stop" }),
      taskId: task.id,
      store,
    });

    expect(store.tasks.get(task.id)?.state).toBe("done");
    expect(queuedMessages()[0]?.message).toEqual({
      kind: "post",
      text: "Nothing to stop: this task is already done.",
    });
  });

  it("cancels a retry of an ended task that hasn't started yet, leaving the task as it was", () => {
    const { queuedMessages, store, task } = setup("failed");
    takeFollowUp({
      message: followUpMessage({ eventId: "EvRetry", text: "try again" }),
      taskId: task.id,
      store,
    });

    takeFollowUp({
      message: followUpMessage({ text: "stop" }),
      taskId: task.id,
      store,
    });

    expect(store.tasks.get(task.id)?.state).toBe("failed");
    expect(store.inputs.tasksWithUndelivered()).toEqual([]);
    expect(store.inputs.unread(task.id)).toEqual([]);
    expect(queuedMessages().at(-1)?.message).toEqual({
      kind: "post",
      text: "Cancelled. This task stays failed, and the messages waiting for it are dropped.",
    });
  });

  it("treats stop inside a longer message as an ordinary input", () => {
    const { store, task } = setup();
    expect(
      takeFollowUp({
        message: followUpMessage({ text: "stop using the old API" }),
        taskId: task.id,
        store,
      }),
    ).toBe("task_input");
    expect(store.tasks.get(task.id)?.state).toBe("running");
  });
});
