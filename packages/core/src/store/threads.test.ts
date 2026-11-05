import { describe, expect, it } from "vitest";
import type { Store } from "./open-store.ts";
import { openTestStore } from "./open-test-store.ts";

const thread = { channel: "C0123ABCD", threadTs: "100.000001" };

const newTask = (store: Store) =>
  store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: thread.channel,
    originTs: thread.threadTs,
  });

describe("threads", () => {
  it("has no owner for a thread it hasn't seen", () => {
    const { store } = openTestStore();
    expect(
      store.threads.owner(thread.channel, thread.threadTs),
    ).toBeUndefined();
  });

  it("records a thread for the router", () => {
    const { store, clock } = openTestStore();
    expect(store.threads.claim({ ...thread, taskId: null })).toEqual({
      ...thread,
      taskId: null,
      createdAt: clock.now,
    });
  });

  it("hands a router thread to a task, keeping when it was first seen", () => {
    const { store, clock } = openTestStore();
    const firstSeenAt = clock.now;
    store.threads.claim({ ...thread, taskId: null });
    clock.now += 1_000;
    const task = newTask(store);

    expect(store.threads.claim({ ...thread, taskId: task.id })).toEqual({
      ...thread,
      taskId: task.id,
      createdAt: firstSeenAt,
    });
  });

  it("lists the threads owned by tasks in the given states", () => {
    const { store } = openTestStore();
    const runningTask = newTask(store);
    store.tasks.transition(runningTask.id, "running");
    const doneTask = newTask(store);
    store.tasks.transition(doneTask.id, "running");
    store.tasks.transition(doneTask.id, "done");
    store.threads.claim({ ...thread, taskId: runningTask.id });
    store.threads.claim({
      channel: "C0123ABCD",
      threadTs: "200.000001",
      taskId: doneTask.id,
    });
    store.threads.claim({
      channel: "C0123ABCD",
      threadTs: "300.000001",
      taskId: null,
    });

    expect(
      store.threads
        .ownedByTasksIn(["running", "waiting"])
        .map(({ threadTs, taskId }) => ({ threadTs, taskId })),
    ).toEqual([{ threadTs: thread.threadTs, taskId: runningTask.id }]);
    expect(store.threads.ownedByTasksIn([])).toEqual([]);
  });

  it("never moves a thread from one task to another, or back to the router", () => {
    const { store } = openTestStore();
    const firstTask = newTask(store);
    const secondTask = newTask(store);
    store.threads.claim({ ...thread, taskId: firstTask.id });

    expect(
      store.threads.claim({ ...thread, taskId: secondTask.id }).taskId,
    ).toBe(firstTask.id);
    expect(store.threads.claim({ ...thread, taskId: null }).taskId).toBe(
      firstTask.id,
    );
  });
});
