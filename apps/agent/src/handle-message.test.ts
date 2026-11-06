import type { Repo } from "@repo/core/repos";
import { decideStartTask } from "@repo/core/router";
import type { InboundMessage } from "@repo/core/slack";
import { IN_MEMORY_STORE, openStore } from "@repo/core/store";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler, type HandlerStore } from "./handle-message.ts";

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
  wrapStore: (store: HandlerStore) => HandlerStore = (store) => store,
) => {
  const store = openStore({ path: IN_MEMORY_STORE });
  const wakeOutbox = vi.fn();
  const wakeTaskRunner = vi.fn();
  const wakeRouter = vi.fn();
  const handleMessage = createMessageHandler({
    store: wrapStore(store),
    wakeOutbox,
    wakeTaskRunner,
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
  const queuedPosts = () => store.outbox.pending();
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
    store,
    wakeOutbox,
    wakeRouter,
    wakeTaskRunner,
  };
};

describe("createMessageHandler", () => {
  it("leaves a DM or a mention no task owns to the router, unsettled, and wakes it", () => {
    const { queuedPosts, receive, store, wakeRouter } = setup();

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

    expect(queuedPosts()).toEqual([]);
    expect(store.tasks.withState(["queued"])).toEqual([]);
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

  it("queues a redelivered or replayed message for the router once", () => {
    const { receive, store } = setup();
    const message = inboundMessage({});

    receive(message);
    receive(message);

    expect(store.candidates.undecided()).toHaveLength(1);
  });

  it("hands a message queued in a thread that a task then took over to that task once, even if it is replayed", () => {
    const superagentRepo: Repo = {
      name: "superagent",
      github: "pakgin/superagent",
      path: "/code/superagent",
      baseBranch: "main",
    };
    const { receive, store } = setup();
    const request = inboundMessage({});
    const followUp = inboundMessage({
      eventId: "Ev2",
      ts: "100.000002",
      text: "also fix the lint",
    });
    receive(request);
    receive(followUp);
    const [requestCandidate] = store.candidates.undecided();

    decideStartTask(
      {
        store,
        repos: new Map([["superagent", superagentRepo]]),
        decidedBy: "router",
      },
      {
        candidateId: requestCandidate?.id ?? 0,
        repo: "superagent",
        reason: "A request.",
      },
    );
    const unfinishedAfterStart = store.events
      .unfinished()
      .map(({ eventId }) => eventId);
    receive(followUp);

    const [task] = store.tasks.withState(["queued"]);
    expect(unfinishedAfterStart).toEqual([]);
    expect(store.candidates.undecided()).toEqual([]);
    expect(store.inputs.unread(task?.id ?? "").map(({ ref }) => ref)).toEqual([
      "Ev1",
      "Ev2",
    ]);
    expect(store.events.get("Ev2")?.disposition).toBe("task_input");
  });

  it("gives a message in a task's thread to that task, not the router", () => {
    const {
      createTaskOwningThread,
      queuedPosts,
      receive,
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

    expect(store.inputs.undelivered(task.id)).toEqual([
      expect.objectContaining({ ref: "Ev2", text: "also the lint" }),
    ]);
    expect(store.candidates.undecided()).toEqual([]);
    expect(queuedPosts()).toEqual([]);
    expect(store.events.get("Ev2")?.disposition).toBe("task_input");
    expect(wakeTaskRunner).toHaveBeenCalledOnce();
  });

  it("ignores a mention-free reply in a thread no task owns any more", () => {
    const { receive, store } = setup();

    receive(inboundMessage({ eventId: "Ev2", via: "thread" }));

    expect(store.candidates.undecided()).toEqual([]);
    expect(store.events.get("Ev2")?.disposition).toBe("ignored");
  });

  it("stops the task when its thread gets the word stop, and settles the event as stopped_task", () => {
    const { createTaskOwningThread, receive, store } = setup();
    const task = createTaskOwningThread();

    receive(inboundMessage({ eventId: "Ev2", ts: "100.000002", text: "stop" }));

    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(store.events.get("Ev2")?.disposition).toBe("stopped_task");
  });

  it("writes nothing and wakes nothing when handling fails, leaving the event unsettled", () => {
    const { receive, store, wakeOutbox, wakeRouter, wakeTaskRunner } = setup(
      (store) => ({
        ...store,
        candidates: {
          ...store.candidates,
          add: () => {
            throw new Error("disk full");
          },
        },
      }),
    );

    expect(() => receive(inboundMessage({}))).toThrow("disk full");
    expect(store.events.get("Ev1")?.disposition).toBe("received");
    expect(wakeOutbox).not.toHaveBeenCalled();
    expect(wakeTaskRunner).not.toHaveBeenCalled();
    expect(wakeRouter).not.toHaveBeenCalled();
  });
});
