import { describe, expect, it } from "vitest";
import type { Store } from "./open-store.ts";
import { openTestStore } from "./open-test-store.ts";
import {
  type NewTask,
  TASK_TRANSITIONS,
  type Task,
  type TaskState,
  taskStateSchema,
} from "./tasks.ts";

const flakyTestTask: NewTask = {
  title: "Fix the flaky test",
  repo: "superagent",
  originChannel: "C0123ABCD",
  originTs: "100.000001",
};

const createTaskIn = (store: Store, state: TaskState): Task => {
  const task = store.tasks.create(flakyTestTask);
  if (state === "queued") return task;
  const runningTask = store.tasks.transition(task.id, "running");
  if (state === "running") return runningTask;
  return store.tasks.transition(task.id, state);
};

const statePairs = taskStateSchema.options.flatMap((from) =>
  taskStateSchema.options.map((to) => ({
    from,
    to,
    isAllowed: TASK_TRANSITIONS[from].includes(to),
  })),
);

describe("tasks", () => {
  it("creates a queued task with a short random ID", () => {
    const { store, clock } = openTestStore();
    const task = store.tasks.create(flakyTestTask);

    expect(task.id).toMatch(/^[a-z2-7]{8}$/);
    expect(task).toEqual({
      ...flakyTestTask,
      id: task.id,
      state: "queued",
      branch: null,
      worktree: null,
      prNumber: null,
      sessionId: null,
      createdAt: clock.now,
      lastActivityAt: clock.now,
    });
    expect(store.tasks.get(task.id)).toEqual(task);
    expect(store.tasks.create(flakyTestTask).id).not.toBe(task.id);
  });

  it("updates the given fields, clears ones set to null, and leaves the rest", () => {
    const { store, clock } = openTestStore();
    const task = store.tasks.create(flakyTestTask);
    store.tasks.update(task.id, {
      branch: "agent/abc",
      worktree: "/data/worktrees/abc",
    });
    clock.now += 1_000;

    const updated = store.tasks.update(task.id, {
      worktree: null,
      prNumber: 42,
      sessionId: "session-1",
    });

    expect(updated).toMatchObject({
      title: flakyTestTask.title,
      branch: "agent/abc",
      worktree: null,
      prNumber: 42,
      sessionId: "session-1",
      lastActivityAt: clock.now,
    });
    expect(store.tasks.update(task.id, {})).toEqual(updated);
  });

  it("refuses to update or move a task that doesn't exist", () => {
    const { store } = openTestStore();
    expect(() => store.tasks.update("missing", { prNumber: 1 })).toThrow(
      "No task missing",
    );
    expect(() => store.tasks.transition("missing", "running")).toThrow(
      "No task missing",
    );
  });

  it.each(statePairs)(
    "$from → $to is allowed: $isAllowed",
    ({ from, to, isAllowed }) => {
      const { store } = openTestStore();
      const task = createTaskIn(store, from);

      if (isAllowed) {
        expect(store.tasks.transition(task.id, to).state).toBe(to);
      } else {
        expect(() => store.tasks.transition(task.id, to)).toThrow(
          `can't move from ${from} to ${to}`,
        );
        expect(store.tasks.get(task.id)?.state).toBe(from);
      }
    },
  );

  it("counts a state change as activity", () => {
    const { store, clock } = openTestStore();
    const task = store.tasks.create(flakyTestTask);
    clock.now += 1_000;
    expect(store.tasks.transition(task.id, "running").lastActivityAt).toBe(
      clock.now,
    );
  });

  it("lists tasks in the given states, oldest first", () => {
    const { store, clock } = openTestStore();
    const waiting = createTaskIn(store, "waiting");
    clock.now += 1;
    createTaskIn(store, "done");
    clock.now += 1;
    const running = createTaskIn(store, "running");

    expect(
      store.tasks.withState(["running", "waiting"]).map(({ id }) => id),
    ).toEqual([waiting.id, running.id]);
    expect(store.tasks.withState([])).toEqual([]);
  });
});
