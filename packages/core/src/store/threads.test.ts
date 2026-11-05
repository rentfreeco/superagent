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
