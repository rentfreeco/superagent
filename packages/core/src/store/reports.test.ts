import { expect, it } from "vitest";
import { openTestStore } from "./open-test-store.ts";

it("returns a task's most recent report", () => {
  const { store, clock } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0123ABCD",
    originTs: "100.000001",
  });
  expect(store.reports.latest(task.id)).toBeUndefined();

  store.reports.add({
    taskId: task.id,
    state: "waiting",
    summary: null,
    question: "Keep the retry, or remove the test?",
  });
  clock.now += 1_000;
  const ready = store.reports.add({
    taskId: task.id,
    state: "ready",
    summary: "Fixed the race in the dedupe test.",
    question: null,
  });

  expect(store.reports.latest(task.id)).toEqual(ready);
  expect(ready.createdAt).toBe(clock.now);
});
