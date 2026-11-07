import { afterEach, describe, expect, it, vi } from "vitest";
import type { Repo } from "../repos/config.ts";
import type { ThreadMessage } from "../slack/thread.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { OutboxMessage } from "../store/outbox.ts";
import type { Store } from "../store/open-store.ts";
import { openTestStore } from "../store/open-test-store.ts";
import type { TaskState } from "../store/tasks.ts";
import type {
  StartWorkerSession,
  WorkerSessionOptions,
  WorkerTurn,
} from "./claude-session.ts";
import type { PrepareWorktree } from "./prepare-worktree.ts";
import { createTaskRunner, type TaskRunner } from "./runner.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const threads = {
  fetchThread: vi.fn(
    async (_channel: string, _threadTs: string): Promise<ThreadMessage[]> => [
      { ts: "1.000001", user: "U0OWNER", text: "fix it", fromSelf: false },
      {
        ts: "1.000002",
        user: "U0SOMEONE",
        text: "do it my way",
        fromSelf: false,
      },
    ],
  ),
};

interface FakeSession {
  options: WorkerSessionOptions;
  sent: TaskInput[][];
  interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>;
  end: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

const idleTurn = (fields: Partial<WorkerTurn>): WorkerTurn => ({
  readInputIds: [],
  isError: false,
  resultText: "",
  isIdle: true,
  ...fields,
});

const runners: TaskRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.stop()));
});

const setup = ({
  maxSessions = 3,
  prepareWorktree = vi.fn<PrepareWorktree>(async ({ taskId }) => ({
    branch: `agent/${taskId}`,
    path: `/data/worktrees/${taskId}`,
  })),
}: { maxSessions?: number; prepareWorktree?: PrepareWorktree } = {}) => {
  const { clock, store } = openTestStore();
  const sessions: FakeSession[] = [];
  const startSession: StartWorkerSession = (options) => {
    const fake: FakeSession = {
      options,
      sent: [[...options.inputs]],
      interrupt: vi.fn(async () => undefined),
      end: vi.fn(),
      close: vi.fn(),
    };
    sessions.push(fake);
    return {
      send: (inputs) => fake.sent.push([...inputs]),
      interrupt: fake.interrupt,
      end: fake.end,
      close: fake.close,
    };
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const wakeOutbox = vi.fn();
  const wakeRouter = vi.fn();
  const runner = createTaskRunner({
    store,
    repos: new Map([["superagent", superagentRepo]]),
    worktreesDirectory: "/data/worktrees",
    startSession,
    wakeOutbox,
    wakeRouter,
    logger,
    ownerUserId: "U0OWNER",
    prepareWorktree,
    maxSessions,
    pollIntervalMs: 60_000,
  });
  runners.push(runner);
  const createTask = (state: TaskState = "queued", repo = "superagent") => {
    clock.now += 1_000;
    const task = store.tasks.create({
      title: "Fix the flaky test",
      repo,
      originChannel: "C0MAPPED",
      originTs: `${clock.now}.000001`,
    });
    if (state !== "queued") store.tasks.transition(task.id, "running");
    if (state !== "queued" && state !== "running") {
      store.tasks.transition(task.id, state);
    }
    return task;
  };
  const addInput = (taskId: string, text = "fix the flaky test") =>
    store.inputs.add({
      taskId,
      source: "slack",
      ref: `Ev-${taskId}-${text}`,
      text,
    });
  const queuedPosts = () =>
    store.outbox
      .pending()
      .map(({ threadTs, message }) => ({ threadTs, message }));
  const sendQueuedMessages = () => {
    const sent: OutboxMessage[] = [];
    for (
      let dueEntries = store.outbox.pending();
      dueEntries.length > 0;
      dueEntries = store.outbox.pending()
    ) {
      for (const { id, message } of dueEntries) {
        sent.push(message);
        store.outbox.markSent(id, null);
      }
    }
    return sent;
  };
  const startRunner = async (expectedSessions: number) => {
    runner.start(threads);
    await vi.waitFor(() => expect(sessions).toHaveLength(expectedSessions));
  };
  return {
    addInput,
    clock,
    createTask,
    logger,
    prepareWorktree,
    queuedPosts,
    runner,
    sendQueuedMessages,
    sessions,
    startRunner,
    store,
    wakeOutbox,
    wakeRouter,
  };
};

const sessionAt = (sessions: readonly FakeSession[], index: number) => {
  const session = sessions[index];
  if (session === undefined) throw new Error(`No session ${index}`);
  return session;
};

const stateOf = (store: Store, taskId: string) =>
  store.tasks.get(taskId)?.state;

const recordOwnerMessage = (store: Store, eventId: string, threadTs: string) =>
  store.events.record({
    eventId,
    type: "message",
    channel: "C0MAPPED",
    ts: "100.000009",
    threadTs,
    user: "U0OWNER",
    text: "what's on my calendar?",
  });

describe("createTaskRunner", () => {
  it("starts a queued task in its own worktree, with its first input, and moves it to running", async () => {
    const {
      addInput,
      createTask,
      prepareWorktree,
      sessions,
      startRunner,
      store,
    } = setup();
    const task = createTask();
    const assignment = addInput(task.id);

    await startRunner(1);

    expect(prepareWorktree).toHaveBeenCalledExactlyOnceWith({
      repo: superagentRepo,
      taskId: task.id,
      worktreesDirectory: "/data/worktrees",
    });
    const { options } = sessionAt(sessions, 0);
    expect(options.task).toMatchObject({
      id: task.id,
      state: "running",
      branch: `agent/${task.id}`,
      worktree: `/data/worktrees/${task.id}`,
    });
    expect(options.worktree).toEqual({
      branch: `agent/${task.id}`,
      path: `/data/worktrees/${task.id}`,
    });
    expect(options.inputs.map(({ id }) => id)).toEqual([assignment?.id]);
    expect(store.inputs.undelivered(task.id)).toEqual([]);
    expect(stateOf(store, task.id)).toBe("running");
  });

  it("keeps the session ID, and marks inputs read as turns consume them", async () => {
    const { addInput, createTask, sessions, startRunner, store } = setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const { events } = sessionAt(sessions, 0).options;

    events.onSessionId("s-1");
    events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0], isIdle: false }),
    );

    expect(store.tasks.get(task.id)?.sessionId).toBe("s-1");
    expect(store.inputs.unread(task.id)).toEqual([]);
  });

  it("posts the worker's report, then ends the session when its turn goes idle", async () => {
    const {
      addInput,
      createTask,
      queuedPosts,
      sessions,
      startRunner,
      store,
      wakeOutbox,
    } = setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);

    expect(
      session.options.report({
        state: "ready",
        summary: "Fixed it.",
        prUrl: "https://github.com/pakgin/superagent/pull/42",
      }).isAccepted,
    ).toBe(true);
    session.options.events.onTurnEnd(idleTurn({ resultText: "Fixed it." }));

    expect(stateOf(store, task.id)).toBe("ready");
    expect(wakeOutbox).toHaveBeenCalled();
    expect(queuedPosts()).toEqual([
      {
        threadTs: task.originTs,
        message: {
          kind: "post",
          text: "Fixed it.\n<https://github.com/pakgin/superagent/pull/42|Pull request #42>",
        },
      },
    ]);
    expect(session.end).toHaveBeenCalledOnce();
  });

  it("passes on the worker's last words and waits on the owner when a turn ends without a report", async () => {
    const { addInput, createTask, queuedPosts, sessions, startRunner, store } =
      setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);

    sessionAt(sessions, 0).options.events.onTurnEnd(
      idleTurn({ resultText: "  The test only fails on Node 22.  " }),
    );

    expect(stateOf(store, task.id)).toBe("waiting");
    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "The test only fails on Node 22.\n\n*Question:* How should I go on?",
    });
    expect(sessionAt(sessions, 0).end).toHaveBeenCalledOnce();
  });

  it("fails the task when a turn ends in an error", async () => {
    const { addInput, createTask, queuedPosts, sessions, startRunner, store } =
      setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);

    sessionAt(sessions, 0).options.events.onTurnEnd(
      idleTurn({ isError: true, resultText: "API error: overloaded" }),
    );

    expect(stateOf(store, task.id)).toBe("failed");
    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "*Failed:* API error: overloaded",
    });
  });

  it("pushes a follow-up into the live session, moving a task that reported back to running", async () => {
    const { addInput, createTask, runner, sessions, startRunner, store } =
      setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    session.options.report({
      state: "waiting",
      summary: "Hm.",
      question: "Which?",
    });

    const followUp = addInput(task.id, "the first one");
    await runner.reconcile();

    expect(session.sent.at(-1)?.map(({ id }) => id)).toEqual([followUp?.id]);
    expect(stateOf(store, task.id)).toBe("running");
    expect(sessions).toHaveLength(1);
  });

  it("keeps an idle session going when a follow-up is waiting to be delivered", async () => {
    const { addInput, createTask, queuedPosts, sessions, startRunner } =
      setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    const followUp = addInput(task.id, "also the docs");

    session.options.events.onTurnEnd(idleTurn({ resultText: "Done." }));

    expect(session.sent.at(-1)?.map(({ id }) => id)).toEqual([followUp?.id]);
    expect(session.end).not.toHaveBeenCalled();
    expect(queuedPosts()).toEqual([]);
  });

  it("hands a message back to the router when the worker calls hand_back, and wakes it", async () => {
    const { addInput, createTask, sessions, startRunner, store, wakeRouter } =
      setup();
    const task = createTask();
    addInput(task.id);
    const offTopic = addInput(task.id, "what's on my calendar?");
    store.events.record({
      eventId: offTopic?.ref ?? "",
      type: "message",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: task.originTs,
      user: "U0OWNER",
      text: "what's on my calendar?",
    });
    await startRunner(1);

    const outcome = sessionAt(sessions, 0).options.handBack(
      offTopic?.id ?? 0,
      "It isn't about the flaky test.",
    );

    expect(outcome.isAccepted).toBe(true);
    expect(store.candidates.undecided()).toEqual([
      expect.objectContaining({
        eventId: offTopic?.ref,
        handedBackBy: task.id,
        handBackReason: "It isn't about the flaky test.",
      }),
    ]);
    expect(wakeRouter).toHaveBeenCalledOnce();
  });

  it("puts 👀 on the owner's messages the worker was given when it calls ack", async () => {
    const {
      addInput,
      createTask,
      queuedPosts,
      sessions,
      startRunner,
      store,
      wakeOutbox,
    } = setup();
    const task = createTask();
    const assignment = addInput(task.id);
    store.events.record({
      eventId: assignment?.ref ?? "",
      type: "app_mention",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: task.originTs,
      user: "U0OWNER",
      text: "fix the flaky test",
    });
    addInput(task.id, "not delivered yet");
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    addInput(task.id, "arrived after the start");
    wakeOutbox.mockClear();

    expect(session.options.ack()).toBe("Put 👀 on the owner's message.");
    expect(session.options.ack()).toBe(
      "There's no new message to acknowledge.",
    );

    expect(wakeOutbox).toHaveBeenCalledOnce();
    expect(queuedPosts()).toEqual([
      {
        threadTs: null,
        message: { kind: "reaction", name: "eyes", timestamp: "100.000002" },
      },
    ]);
  });

  it("reads the task's thread for the worker, showing only the owner and superagent", async () => {
    const { addInput, createTask, sessions, startRunner } = setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);

    const thread = await sessionAt(sessions, 0).options.readThread();

    expect(threads.fetchThread).toHaveBeenLastCalledWith(
      "C0MAPPED",
      task.originTs,
    );
    expect(thread).toBe(
      "(1 messages from other people left out. Only the owner's messages and superagent's own are shown.)\n\n[owner]\nfix it",
    );
  });

  describe("when a follow-up lands after the worker reported", () => {
    const reportThenQueueFollowUp = async () => {
      const context = setup();
      const task = context.createTask();
      const assignment = context.addInput(task.id);
      await context.startRunner(1);
      const session = sessionAt(context.sessions, 0);
      context.addInput(task.id, "also update the docs");
      await context.runner.reconcile();
      session.options.report({
        state: "waiting",
        summary: "Two tests share a port.",
        question: "Which one moves?",
      });
      return { ...context, assignment, session, task };
    };

    it("moves the task back to running when the turn ends with the follow-up still queued, so the next turn's report posts", async () => {
      const { assignment, sendQueuedMessages, session, store, task } =
        await reportThenQueueFollowUp();

      session.options.events.onTurnEnd(
        idleTurn({ readInputIds: [assignment?.id ?? 0], isIdle: false }),
      );
      expect(stateOf(store, task.id)).toBe("running");
      const nextTurnReport = session.options.report({
        state: "done",
        summary: "Docs updated.",
      });

      expect(nextTurnReport.isAccepted).toBe(true);
      expect(stateOf(store, task.id)).toBe("done");
      expect(sendQueuedMessages()).toEqual([
        {
          kind: "post",
          text: "Two tests share a port.\n\n*Question:* Which one moves?",
        },
        { kind: "post", text: "Docs updated." },
      ]);
    });

    it("posts the next turn's last words when it ends without a report", async () => {
      const { assignment, sendQueuedMessages, session, store, task } =
        await reportThenQueueFollowUp();

      session.options.events.onTurnEnd(
        idleTurn({ readInputIds: [assignment?.id ?? 0], isIdle: false }),
      );
      session.options.events.onTurnEnd(
        idleTurn({ resultText: "Updated the docs too." }),
      );

      expect(stateOf(store, task.id)).toBe("waiting");
      expect(sendQueuedMessages().at(-1)).toEqual({
        kind: "post",
        text: "Updated the docs too.\n\n*Question:* How should I go on?",
      });
    });

    it("takes the worker's next report in the same turn, when the follow-up was folded in after its first", async () => {
      const { sendQueuedMessages, session, store, task } =
        await reportThenQueueFollowUp();

      const secondReport = session.options.report({
        state: "done",
        summary: "Moved one test and updated the docs.",
      });

      expect(secondReport.isAccepted).toBe(true);
      expect(stateOf(store, task.id)).toBe("done");
      expect(sendQueuedMessages()).toHaveLength(2);
    });
  });

  it("never reopens a stopped task for a queued turn, a delivery, or a late report", async () => {
    const { addInput, createTask, queuedPosts, sessions, startRunner, store } =
      setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    store.tasks.transition(task.id, "stopped");

    session.options.events.onTurnEnd(idleTurn({ isIdle: false }));
    addInput(task.id, "one more thing");
    session.options.events.onTurnEnd(idleTurn({}));
    const lateReport = session.options.report({
      state: "done",
      summary: "Finished anyway.",
    });

    expect(lateReport.isAccepted).toBe(false);
    expect(stateOf(store, task.id)).toBe("stopped");
    expect(queuedPosts()).toEqual([]);
  });

  it("resumes an ended task's session when the owner sends something new", async () => {
    const { addInput, createTask, runner, sessions, startRunner, store } =
      setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const first = sessionAt(sessions, 0);
    first.options.events.onSessionId("s-1");
    first.options.report({ state: "done", summary: "It's the cache." });
    first.options.events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0] }),
    );
    first.options.events.onEnd(undefined);
    await runner.reconcile();
    expect(sessions).toHaveLength(1);

    const followUp = addInput(task.id, "then clear it on deploy");
    await runner.reconcile();

    const resumed = sessionAt(sessions, 1);
    expect(resumed.options.task).toMatchObject({
      sessionId: "s-1",
      state: "running",
    });
    expect(resumed.options.inputs.map(({ id }) => id)).toEqual([followUp?.id]);
    expect(stateOf(store, task.id)).toBe("running");
  });

  it("puts a task back in its reported state, without a post, when the worker hands a message back and has nothing to report", async () => {
    const {
      addInput,
      createTask,
      queuedPosts,
      runner,
      sessions,
      startRunner,
      store,
    } = setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const first = sessionAt(sessions, 0);
    first.options.report({ state: "done", summary: "It's the cache." });
    first.options.events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0] }),
    );
    first.options.events.onEnd(undefined);
    const offTopic = addInput(task.id, "what's on my calendar?");
    recordOwnerMessage(store, offTopic?.ref ?? "", task.originTs);
    await runner.reconcile();
    const resumed = sessionAt(sessions, 1);
    const postsBefore = queuedPosts().length;

    resumed.options.handBack(offTopic?.id ?? 0, "It isn't about the cache.");
    const outcome = resumed.options.nothingToReport();
    resumed.options.events.onTurnEnd(
      idleTurn({ readInputIds: [offTopic?.id ?? 0], resultText: "Done." }),
    );

    expect(outcome).toEqual({
      isAccepted: true,
      reply: "The task stays done, and nothing is posted. End your turn.",
    });
    expect(stateOf(store, task.id)).toBe("done");
    expect(queuedPosts()).toHaveLength(postsBefore);
    expect(resumed.end).toHaveBeenCalledOnce();
  });

  it("refuses nothing_to_report in a turn that handed nothing back", async () => {
    const { addInput, createTask, runner, sessions, startRunner } = setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const first = sessionAt(sessions, 0);
    first.options.report({ state: "done", summary: "It's the cache." });
    first.options.events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0] }),
    );
    first.options.events.onEnd(undefined);
    addInput(task.id, "then clear it on deploy");
    await runner.reconcile();

    expect(sessionAt(sessions, 1).options.nothingToReport()).toEqual({
      isAccepted: false,
      reply:
        "Use nothing_to_report only in a turn where you handed a message back. Otherwise report where the task stands.",
    });
  });

  it("refuses nothing_to_report before the task ever reported", async () => {
    const { addInput, createTask, sessions, startRunner, store } = setup();
    const task = createTask();
    addInput(task.id);
    const offTopic = addInput(task.id, "what's on my calendar?");
    recordOwnerMessage(store, offTopic?.ref ?? "", task.originTs);
    await startRunner(1);
    const session = sessionAt(sessions, 0);

    session.options.handBack(offTopic?.id ?? 0, "It isn't about the cache.");

    expect(session.options.nothingToReport()).toEqual({
      isAccepted: false,
      reply:
        "This task hasn't reported yet, so there's nothing to go back to. Report where it stands.",
    });
  });

  it("still waits on the owner when a turn hands a message back but doesn't say it has nothing to report", async () => {
    const { addInput, createTask, runner, sessions, startRunner, store } =
      setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const first = sessionAt(sessions, 0);
    first.options.report({ state: "done", summary: "It's the cache." });
    first.options.events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0] }),
    );
    first.options.events.onEnd(undefined);
    const followUp = addInput(task.id, "then clear it on deploy");
    const offTopic = addInput(task.id, "what's on my calendar?");
    recordOwnerMessage(store, offTopic?.ref ?? "", task.originTs);
    await runner.reconcile();
    const resumed = sessionAt(sessions, 1);

    resumed.options.handBack(offTopic?.id ?? 0, "It isn't about the cache.");
    resumed.options.events.onTurnEnd(
      idleTurn({
        readInputIds: [followUp?.id ?? 0, offTopic?.id ?? 0],
        resultText: "Looking at the deploy script.",
      }),
    );

    expect(stateOf(store, task.id)).toBe("waiting");
    expect(store.reports.latest(task.id)?.summary).toBe(
      "Looking at the deploy script.",
    );
  });

  it("forgets a nothing_to_report once its turn ends", async () => {
    const { addInput, createTask, runner, sessions, startRunner, store } =
      setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    session.options.report({ state: "done", summary: "It's the cache." });
    const offTopic = addInput(task.id, "what's on my calendar?");
    recordOwnerMessage(store, offTopic?.ref ?? "", task.originTs);
    await runner.reconcile();
    session.options.handBack(offTopic?.id ?? 0, "It isn't about the cache.");
    session.options.nothingToReport();
    session.options.events.onTurnEnd({
      readInputIds: [assignment?.id ?? 0, offTopic?.id ?? 0],
      isError: false,
      resultText: "",
      isIdle: false,
    });
    const followUp = addInput(task.id, "then clear it on deploy");
    await runner.reconcile();

    session.options.events.onTurnEnd(
      idleTurn({
        readInputIds: [followUp?.id ?? 0],
        resultText: "Looking at the deploy script.",
      }),
    );

    expect(stateOf(store, task.id)).toBe("waiting");
  });

  it("resumes a task a restart left running, with everything it hadn't read", async () => {
    const { addInput, createTask, sessions, startRunner, store } = setup();
    const task = createTask("running");
    store.tasks.update(task.id, { sessionId: "s-1" });
    const deliveredBeforeRestart = addInput(task.id, "also the lint");
    store.inputs.markDelivered([deliveredBeforeRestart?.id ?? 0]);
    const restartNote = store.inputs.add({
      taskId: task.id,
      source: "system",
      ref: null,
      text: "The superagent service restarted.",
    });

    await startRunner(1);

    expect(sessionAt(sessions, 0).options.task.sessionId).toBe("s-1");
    expect(sessionAt(sessions, 0).options.inputs.map(({ id }) => id)).toEqual([
      deliveredBeforeRestart?.id,
      restartNote?.id,
    ]);
  });

  it("leaves a task alone when nothing new has arrived for it", async () => {
    const { addInput, createTask, runner, sessions, store } = setup();
    const task = createTask("waiting");
    const unreadButDelivered = addInput(task.id);
    store.inputs.markDelivered([unreadButDelivered?.id ?? 0]);
    createTask("running");

    runner.start(threads);
    await runner.reconcile();

    expect(sessions).toEqual([]);
  });

  it("interrupts and ends the session of a task the owner stopped, and posts nothing more", async () => {
    const {
      addInput,
      createTask,
      queuedPosts,
      runner,
      sessions,
      startRunner,
      store,
    } = setup();
    const task = createTask();
    const assignment = addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);
    session.options.events.onTurnEnd(
      idleTurn({ readInputIds: [assignment?.id ?? 0], isIdle: false }),
    );

    store.tasks.transition(task.id, "stopped");
    await runner.reconcile();
    await vi.waitFor(() => expect(session.end).toHaveBeenCalledOnce());
    addInput(task.id, "actually, keep going");
    await runner.reconcile();
    session.options.events.onTurnEnd(idleTurn({ isError: true }));

    expect(session.interrupt).toHaveBeenCalledOnce();
    expect(session.sent).toHaveLength(1);
    expect(stateOf(store, task.id)).toBe("stopped");
    expect(queuedPosts()).toEqual([]);

    session.options.events.onEnd(undefined);
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(
      sessionAt(sessions, 1).options.inputs.map(({ text }) => text),
    ).toEqual(["actually, keep going"]);
  });

  it("fails a task whose session ends before the worker reported", async () => {
    const {
      addInput,
      createTask,
      logger,
      queuedPosts,
      sessions,
      startRunner,
      store,
    } = setup();
    const crashed = createTask();
    addInput(crashed.id);
    const quiet = createTask();
    addInput(quiet.id);
    await startRunner(2);

    sessionAt(sessions, 0).options.events.onEnd(
      new Error("exited with code 1"),
    );
    sessionAt(sessions, 1).options.events.onEnd(undefined);

    expect(stateOf(store, crashed.id)).toBe("failed");
    expect(stateOf(store, quiet.id)).toBe("failed");
    expect(queuedPosts().map(({ message }) => message)).toEqual([
      {
        kind: "post",
        text: "*Failed:* The Claude Code session stopped: exited with code 1",
      },
      {
        kind: "post",
        text: "*Failed:* The Claude Code session ended before the worker reported.",
      },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      `tasks: ${crashed.id}'s session failed: exited with code 1`,
    );
  });

  it("fails a task it can't start, and tries again only when the owner sends something new", async () => {
    const prepareWorktree = vi
      .fn<PrepareWorktree>()
      .mockRejectedValueOnce(new Error("git fetch failed"))
      .mockResolvedValue({ branch: "agent/x", path: "/data/worktrees/x" });
    const { addInput, createTask, queuedPosts, runner, sessions, store } =
      setup({
        prepareWorktree,
      });
    const task = createTask();
    addInput(task.id);

    runner.start(threads);
    await vi.waitFor(() => expect(stateOf(store, task.id)).toBe("failed"));
    await runner.reconcile();

    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "*Failed:* Couldn't start: git fetch failed",
    });
    expect(prepareWorktree).toHaveBeenCalledOnce();

    addInput(task.id, "try again");
    await runner.reconcile();
    expect(sessions).toHaveLength(1);
    expect(
      sessionAt(sessions, 0).options.inputs.map(({ text }) => text),
    ).toEqual(["fix the flaky test", "try again"]);
  });

  it("fails a task whose repo is no longer configured", async () => {
    const { addInput, createTask, queuedPosts, runner, store } = setup();
    const task = createTask("queued", "retired-repo");
    addInput(task.id);

    runner.start(threads);
    await vi.waitFor(() => expect(stateOf(store, task.id)).toBe("failed"));

    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "*Failed:* Couldn't start: the repo retired-repo isn't in the superagent config",
    });
  });

  it("runs at most maxSessions sessions at once, oldest task first", async () => {
    const { addInput, createTask, runner, sessions, startRunner } = setup({
      maxSessions: 2,
    });
    const tasks = [createTask(), createTask(), createTask()];
    for (const task of tasks) addInput(task.id);

    await startRunner(2);
    await runner.reconcile();
    expect(sessions.map(({ options }) => options.task.id)).toEqual([
      tasks[0]?.id,
      tasks[1]?.id,
    ]);

    sessionAt(sessions, 0).options.events.onEnd(undefined);
    await vi.waitFor(() => expect(sessions).toHaveLength(3));
    expect(sessionAt(sessions, 2).options.task.id).toBe(tasks[2]?.id);
  });

  it("starts no session for a task the owner stopped while its worktree was being prepared", async () => {
    const worktreeReady = Promise.withResolvers<{
      branch: string;
      path: string;
    }>();
    const prepareWorktree = vi.fn<PrepareWorktree>(() => worktreeReady.promise);
    const { addInput, createTask, runner, sessions, store } = setup({
      prepareWorktree,
    });
    const task = createTask();
    addInput(task.id);
    runner.start(threads);
    await vi.waitFor(() => expect(prepareWorktree).toHaveBeenCalledOnce());

    store.tasks.transition(task.id, "stopped");
    worktreeReady.resolve({ branch: "agent/x", path: "/data/worktrees/x" });
    await runner.reconcile();
    await vi.waitFor(() => expect(store.tasks.get(task.id)?.branch).toBeNull());

    expect(sessions).toEqual([]);
  });

  it("on stop, lets a launch in progress finish without starting a session, and posts nothing for sessions ending meanwhile", async () => {
    const worktreeReady = Promise.withResolvers<{
      branch: string;
      path: string;
    }>();
    const prepareWorktree = vi
      .fn<PrepareWorktree>()
      .mockResolvedValueOnce({ branch: "agent/a", path: "/data/worktrees/a" })
      .mockReturnValueOnce(worktreeReady.promise);
    const {
      addInput,
      createTask,
      queuedPosts,
      runner,
      sessions,
      startRunner,
      store,
    } = setup({ prepareWorktree });
    const live = createTask();
    addInput(live.id);
    await startRunner(1);
    const launching = createTask();
    addInput(launching.id);
    await vi.waitFor(() => {
      runner.wake();
      expect(prepareWorktree).toHaveBeenCalledTimes(2);
    });

    const stopped = runner.stop();
    sessionAt(sessions, 0).options.events.onEnd(new Error("killed"));
    worktreeReady.resolve({ branch: "agent/b", path: "/data/worktrees/b" });
    await stopped;

    expect(sessions).toHaveLength(1);
    expect(stateOf(store, launching.id)).toBe("running");
    expect(stateOf(store, live.id)).toBe("running");
    expect(queuedPosts()).toEqual([]);
  });

  it("closes its sessions on stop and leaves their tasks running for the next start", async () => {
    const {
      addInput,
      createTask,
      queuedPosts,
      runner,
      sessions,
      startRunner,
      store,
    } = setup();
    const task = createTask();
    addInput(task.id);
    await startRunner(1);
    const session = sessionAt(sessions, 0);

    await runner.stop();
    session.options.events.onEnd(undefined);

    expect(session.close).toHaveBeenCalledOnce();
    expect(stateOf(store, task.id)).toBe("running");
    expect(queuedPosts()).toEqual([]);
  });
});
