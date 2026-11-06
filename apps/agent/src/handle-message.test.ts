import type { Repo } from "@repo/core/repos";
import type { InboundMessage } from "@repo/core/slack";
import { IN_MEMORY_STORE, openStore } from "@repo/core/store";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler, type StartTask } from "./handle-message.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const channelRepos = new Map([["C0123ABCD", superagentRepo]]);

const inboundMessage = (fields: Partial<InboundMessage>): InboundMessage => ({
  eventId: "Ev1",
  channel: "C0123ABCD",
  ts: "100.000001",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "fix the flaky test",
  via: "mention",
  ...fields,
});

const setup = (
  startTask: StartTask = vi.fn(),
  { routeThroughRouter = false }: { routeThroughRouter?: boolean } = {},
) => {
  const store = openStore({ path: IN_MEMORY_STORE });
  const wakeOutbox = vi.fn();
  const wakeTaskRunner = vi.fn();
  const wakeRouter = vi.fn();
  const handleMessage = createMessageHandler({
    channelRepos,
    startTask,
    store,
    wakeOutbox,
    wakeTaskRunner,
    routeThroughRouter,
    wakeRouter,
  });
  const receive = (message: InboundMessage): void => {
    store.events.record({
      eventId: message.eventId,
      type: message.via === "dm" ? "message" : "app_mention",
      channel: message.channel,
      ts: message.ts,
      threadTs: null,
      user: message.user,
      text: message.text,
    });
    handleMessage(message);
  };
  const queuedPosts = () =>
    store.outbox.pending().map(({ dedupeKey, channel, threadTs, message }) => ({
      dedupeKey,
      channel,
      threadTs,
      message,
    }));
  const createTaskOwningThread = () => {
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
    return task;
  };
  return {
    createTaskOwningThread,
    queuedPosts,
    receive,
    startTask,
    store,
    wakeOutbox,
    wakeRouter,
    wakeTaskRunner,
  };
};

describe("createMessageHandler with the router", () => {
  it("leaves a DM or a mention no task owns to the router, unsettled, and wakes it", () => {
    const { queuedPosts, receive, startTask, store, wakeRouter } = setup(
      vi.fn(),
      { routeThroughRouter: true },
    );

    receive(inboundMessage({ eventId: "EvMention" }));
    receive(
      inboundMessage({
        eventId: "EvDm",
        channel: "D0123ABCD",
        ts: "200.000001",
        threadTs: "200.000001",
        via: "dm",
      }),
    );

    expect(startTask).not.toHaveBeenCalled();
    expect(queuedPosts()).toEqual([]);
    expect(
      store.candidates
        .undecided()
        .map(({ eventId, via }) => ({ eventId, via })),
    ).toEqual([
      { eventId: "EvMention", via: "mention" },
      { eventId: "EvDm", via: "dm" },
    ]);
    expect(store.events.get("EvMention")?.disposition).toBe("received");
    expect(wakeRouter).toHaveBeenCalledTimes(2);
  });

  it("still gives a message in a task's thread to that task, not the router", () => {
    const { createTaskOwningThread, receive, store } = setup(vi.fn(), {
      routeThroughRouter: true,
    });
    createTaskOwningThread();

    receive(inboundMessage({ eventId: "Ev2", ts: "100.000002" }));

    expect(store.candidates.undecided()).toEqual([]);
    expect(store.events.get("Ev2")?.disposition).toBe("task_input");
  });

  it("queues a redelivered or replayed message for the router once", () => {
    const { receive, store } = setup(vi.fn(), { routeThroughRouter: true });
    const message = inboundMessage({});

    receive(message);
    receive(message);

    expect(store.candidates.undecided()).toHaveLength(1);
  });
});

describe("createMessageHandler", () => {
  it("starts a task for a mention in a mapped channel and settles it as routed", () => {
    const { receive, startTask, store, wakeOutbox, wakeTaskRunner } = setup();
    const message = inboundMessage({});

    receive(message);

    expect(startTask).toHaveBeenCalledExactlyOnceWith({
      message,
      repo: superagentRepo,
      store,
    });
    expect(store.events.get("Ev1")?.disposition).toBe("routed");
    expect(wakeOutbox).toHaveBeenCalledOnce();
    expect(wakeTaskRunner).toHaveBeenCalledOnce();
  });

  it("gives a message in a task's thread to that task instead of starting another", () => {
    const {
      createTaskOwningThread,
      queuedPosts,
      receive,
      startTask,
      store,
      wakeTaskRunner,
    } = setup();
    const task = createTaskOwningThread();

    receive(
      inboundMessage({
        eventId: "Ev2",
        ts: "100.000002",
        text: "also the lint",
      }),
    );

    expect(startTask).not.toHaveBeenCalled();
    expect(store.inputs.undelivered(task.id)).toEqual([
      expect.objectContaining({ ref: "Ev2", text: "also the lint" }),
    ]);
    expect(queuedPosts()).toEqual([]);
    expect(store.events.get("Ev2")?.disposition).toBe("task_input");
    expect(wakeTaskRunner).toHaveBeenCalledOnce();
  });

  it("ignores a mention-free reply in a thread no task owns any more", () => {
    const { queuedPosts, receive, startTask, store } = setup();

    receive(inboundMessage({ eventId: "Ev2", via: "thread" }));

    expect(startTask).not.toHaveBeenCalled();
    expect(queuedPosts()).toEqual([]);
    expect(store.events.get("Ev2")?.disposition).toBe("ignored");
  });

  it("stops the task when its thread gets the word stop, and settles the event as stopped_task", () => {
    const { createTaskOwningThread, receive, store } = setup();
    const task = createTaskOwningThread();

    receive(inboundMessage({ eventId: "Ev2", ts: "100.000002", text: "stop" }));

    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(store.events.get("Ev2")?.disposition).toBe("stopped_task");
  });

  it("queues a reply to a DM in its thread and settles it as replied", () => {
    const { queuedPosts, receive, startTask, store, wakeOutbox } = setup();

    receive(inboundMessage({ channel: "D0123ABCD", via: "dm" }));

    expect(queuedPosts()).toEqual([
      {
        dedupeKey: "reply:Ev1",
        channel: "D0123ABCD",
        threadTs: "100.000001",
        message: {
          kind: "post",
          text: expect.stringContaining("DMs don't map to a repo"),
        },
      },
    ]);
    expect(startTask).not.toHaveBeenCalled();
    expect(store.events.get("Ev1")?.disposition).toBe("replied");
    expect(wakeOutbox).toHaveBeenCalledOnce();
  });

  it("queues a reply to a mention in an unmapped channel", () => {
    const { queuedPosts, receive } = setup();
    receive(inboundMessage({ channel: "C0999ZZZZ" }));
    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: expect.stringContaining("C0999ZZZZ"),
    });
  });

  it("queues one reply when the same event is handled twice", () => {
    const { queuedPosts, receive } = setup();
    const message = inboundMessage({ channel: "D0123ABCD", via: "dm" });
    receive(message);
    receive(message);
    expect(queuedPosts()).toHaveLength(1);
  });

  it("writes nothing and leaves the event unsettled when starting the task fails", () => {
    const failingStart: StartTask = ({ message, store }) => {
      store.outbox.enqueue({
        dedupeKey: `ack:${message.eventId}`,
        channel: message.channel,
        threadTs: message.threadTs,
        message: { kind: "post", text: "on it" },
      });
      throw new Error("worktree failed");
    };
    const { queuedPosts, receive, store, wakeOutbox, wakeTaskRunner } =
      setup(failingStart);

    expect(() => receive(inboundMessage({}))).toThrow("worktree failed");
    expect(queuedPosts()).toEqual([]);
    expect(store.events.get("Ev1")?.disposition).toBe("received");
    expect(wakeOutbox).not.toHaveBeenCalled();
    expect(wakeTaskRunner).not.toHaveBeenCalled();
  });

  it("refuses a startTask that returns a promise, without settling the event", () => {
    const laterWrite = Promise.withResolvers<void>();
    // @ts-expect-error -- StartTask must be synchronous, so an async one must not type-check
    const asyncStart: StartTask = async () => {
      await laterWrite.promise;
    };
    const { queuedPosts, receive, store, wakeOutbox } = setup(asyncStart);

    expect(() => receive(inboundMessage({}))).toThrow(/must be synchronous/);
    expect(store.events.get("Ev1")?.disposition).toBe("received");
    expect(queuedPosts()).toEqual([]);
    expect(wakeOutbox).not.toHaveBeenCalled();
    laterWrite.resolve();
  });
});
