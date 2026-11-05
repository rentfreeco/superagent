import { describe, expect, it } from "vitest";
import type { NewTaskInput } from "./inputs.ts";
import { openTestStore } from "./open-test-store.ts";

const setup = () => {
  const testStore = openTestStore();
  const createTask = () =>
    testStore.store.tasks.create({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "C0123ABCD",
      originTs: "100.000001",
    });
  return { ...testStore, createTask };
};

describe("inputs", () => {
  it("adds an input that hasn't been delivered or read", () => {
    const { store, clock, createTask } = setup();
    const task = createTask();

    expect(
      store.inputs.add({
        taskId: task.id,
        source: "slack",
        ref: "Ev1",
        text: "also fix the lint",
      }),
    ).toEqual({
      id: 1,
      taskId: task.id,
      source: "slack",
      ref: "Ev1",
      text: "also fix the lint",
      createdAt: clock.now,
      deliveredAt: null,
      readAt: null,
    });
  });

  it("adds the same source and ref only once", () => {
    const { store, createTask } = setup();
    const task = createTask();
    const comment: NewTaskInput = {
      taskId: task.id,
      source: "github",
      ref: "comment-7",
      text: "rename this",
    };

    expect(store.inputs.add(comment)).toBeDefined();
    expect(store.inputs.add(comment)).toBeUndefined();
    expect(store.inputs.undelivered(task.id)).toHaveLength(1);
  });

  it("doesn't treat inputs without a ref as duplicates", () => {
    const { store, createTask } = setup();
    const task = createTask();
    const restarted: NewTaskInput = {
      taskId: task.id,
      source: "system",
      ref: null,
      text: "The service restarted.",
    };

    store.inputs.add(restarted);
    store.inputs.add(restarted);
    expect(store.inputs.undelivered(task.id)).toHaveLength(2);
  });

  it("tracks what is still waiting to be delivered, per task", () => {
    const { store, clock, createTask } = setup();
    const firstTask = createTask();
    const secondTask = createTask();
    const [first, second] = ["one", "two"].map((text) =>
      store.inputs.add({
        taskId: firstTask.id,
        source: "system",
        ref: null,
        text,
      }),
    );
    store.inputs.add({
      taskId: secondTask.id,
      source: "system",
      ref: null,
      text: "three",
    });

    store.inputs.markDelivered(first === undefined ? [] : [first.id]);
    clock.now += 1_000;
    store.inputs.markRead(second === undefined ? [] : [second.id]);

    expect(
      store.inputs.undelivered(firstTask.id).map(({ text }) => text),
    ).toEqual(["two"]);
    expect(store.inputs.undelivered(firstTask.id)[0]?.readAt).toBe(clock.now);
    expect(store.inputs.tasksWithUndelivered()).toEqual(
      [firstTask.id, secondTask.id].sort(),
    );
  });

  it("treats marking an input delivered or read again as harmless", () => {
    const { store, createTask } = setup();
    const task = createTask();
    const input = store.inputs.add({
      taskId: task.id,
      source: "router",
      ref: "route-1",
      text: "start",
    });
    const inputIds = input === undefined ? [] : [input.id];

    store.inputs.markDelivered(inputIds);
    store.inputs.markDelivered(inputIds);
    store.inputs.markRead(inputIds);
    store.inputs.markRead(inputIds);

    expect(store.inputs.undelivered(task.id)).toEqual([]);
    expect(store.inputs.tasksWithUndelivered()).toEqual([]);
  });
});
