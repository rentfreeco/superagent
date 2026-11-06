import { describe, expect, it } from "vitest";
import type { Repo } from "../repos/config.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { startTask } from "./start-task.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const inboundMessage = (fields: Partial<InboundMessage>): InboundMessage => ({
  eventId: "Ev1",
  channel: "C0MAPPED",
  ts: "100.000002",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "fix the flaky test\nit fails on CI about once a day",
  via: "mention",
  ...fields,
});

describe("startTask", () => {
  it("queues a task that owns the thread, with the message as its first input, and posts nothing", () => {
    const { store } = openTestStore();

    startTask({ message: inboundMessage({}), repo: superagentRepo, store });

    const [task] = store.tasks.withState(["queued"]);
    expect(task).toMatchObject({
      title: "fix the flaky test",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "100.000001",
      branch: null,
      sessionId: null,
    });
    expect(store.threads.owner("C0MAPPED", "100.000001")?.taskId).toBe(
      task?.id,
    );
    expect(store.inputs.undelivered(task?.id ?? "")).toEqual([
      expect.objectContaining({
        source: "slack",
        ref: "Ev1",
        text: "fix the flaky test\nit fails on CI about once a day",
      }),
    ]);
    expect(store.outbox.pending()).toEqual([]);
  });

  it("titles the task with the first line that has text, cut to fit", () => {
    const { clock, store } = openTestStore();

    startTask({
      message: inboundMessage({ text: `\n   \n${"a".repeat(100)}` }),
      repo: superagentRepo,
      store,
    });
    clock.now += 1_000;
    startTask({
      message: inboundMessage({
        eventId: "Ev2",
        threadTs: "200.000001",
        text: "",
      }),
      repo: superagentRepo,
      store,
    });

    expect(store.tasks.withState(["queued"]).map(({ title }) => title)).toEqual(
      [`${"a".repeat(79)}…`, "Untitled request"],
    );
  });

  it("refuses a thread that already belongs to another task", () => {
    const { store } = openTestStore();
    startTask({ message: inboundMessage({}), repo: superagentRepo, store });

    expect(() =>
      startTask({
        message: inboundMessage({ eventId: "Ev2" }),
        repo: superagentRepo,
        store,
      }),
    ).toThrow(/already belongs to task/);
  });
});
