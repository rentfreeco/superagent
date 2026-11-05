import { describe, expect, it, vi } from "vitest";
import type { NewEvent, StoredEvent } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { openTestStore } from "../store/open-test-store.ts";
import type { TaskState } from "../store/tasks.ts";
import {
  RESTART_NOTE,
  recoverAfterRestart,
  type RecoveryCatchUpResult,
  type RecoveryCatchUpTarget,
  type RecoverySlack,
  takeRecoverySnapshot,
} from "./recover.ts";

const OWNER = "U0OWNER";

const ownerMessage = (fields: Partial<NewEvent>): NewEvent => ({
  eventId: "Ev1",
  type: "message",
  channel: "D0OWNER",
  ts: "100.000001",
  threadTs: null,
  user: OWNER,
  text: "fix the flaky test",
  ...fields,
});

const createTaskIn = (store: Store, state: TaskState, originTs: string) => {
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs,
  });
  if (state === "queued") return task;
  store.tasks.transition(task.id, "running");
  return state === "running" ? task : store.tasks.transition(task.id, state);
};

const setup = () => {
  const { store } = openTestStore();
  const slack = {
    replay: vi.fn(async (_event: StoredEvent) => undefined),
    catchUp: vi.fn(
      async (
        _target: RecoveryCatchUpTarget,
      ): Promise<RecoveryCatchUpResult> => ({
        fed: 1,
        failed: 0,
      }),
    ),
  } satisfies RecoverySlack;
  const logger = { error: vi.fn() };
  const recover = (channels: readonly string[] = []) =>
    recoverAfterRestart({
      store,
      slack,
      snapshot: takeRecoverySnapshot({ store, ownerUserId: OWNER, channels }),
      logger,
    });
  return { logger, recover, slack, store };
};

describe("recoverAfterRestart", () => {
  it("works from the snapshot, so nothing recorded after connecting moves a starting point or adds a task", async () => {
    const { logger, slack, store } = setup();
    store.events.record(
      ownerMessage({ eventId: "EvBeforeDowntime", ts: "100.000005" }),
    );
    store.events.setDisposition("EvBeforeDowntime", "replied");
    const taskBeforeDowntime = createTaskIn(store, "running", "300.000001");
    store.threads.claim({
      channel: "C0MAPPED",
      threadTs: taskBeforeDowntime.originTs,
      taskId: taskBeforeDowntime.id,
    });
    const snapshot = takeRecoverySnapshot({
      store,
      ownerUserId: OWNER,
      channels: [],
    });

    store.events.record(
      ownerMessage({ eventId: "EvBotEcho", user: "U0BOT", ts: "100.000099" }),
    );
    store.events.record(
      ownerMessage({
        eventId: "EvLiveReply",
        type: "app_mention",
        channel: "C0MAPPED",
        ts: "300.000099",
        threadTs: "300.000001",
      }),
    );
    const taskStartedAfterConnecting = createTaskIn(
      store,
      "running",
      "400.000001",
    );

    await recoverAfterRestart({ store, slack, snapshot, logger });

    expect(slack.catchUp.mock.calls.map(([target]) => target)).toEqual([
      { channel: "D0OWNER", threadTs: null, oldest: "100.000005" },
      { channel: "C0MAPPED", threadTs: "300.000001", oldest: "300.000001" },
    ]);
    expect(store.inputs.undelivered(taskStartedAfterConnecting.id)).toEqual([]);
    expect(store.inputs.tasksWithUndelivered()).toEqual([
      taskBeforeDowntime.id,
    ]);
  });

  it("replays the unfinished events in order, and keeps going past one that fails", async () => {
    const { logger, recover, slack, store } = setup();
    store.events.record(ownerMessage({ eventId: "EvFirst" }));
    store.events.record(
      ownerMessage({ eventId: "EvSecond", ts: "100.000002" }),
    );
    store.events.record(
      ownerMessage({ eventId: "EvSettled", ts: "100.000003" }),
    );
    store.events.setDisposition("EvSettled", "replied");
    slack.replay.mockRejectedValueOnce(new Error("handler failed"));

    const report = await recover();

    expect(slack.replay.mock.calls.map(([event]) => event.eventId)).toEqual([
      "EvFirst",
      "EvSecond",
    ]);
    expect(report).toMatchObject({ replayedEvents: 1, failures: 1 });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "recovery: replaying event EvFirst failed: handler failed",
    );
  });

  it("tells each running task, and only those, that the service restarted", async () => {
    const { recover, store } = setup();
    const running = createTaskIn(store, "running", "1.000001");
    const waiting = createTaskIn(store, "waiting", "1.000002");
    createTaskIn(store, "done", "1.000003");

    const report = await recover();

    expect(store.inputs.undelivered(running.id)).toEqual([
      expect.objectContaining({
        source: "system",
        ref: null,
        text: RESTART_NOTE,
      }),
    ]);
    expect(store.inputs.undelivered(waiting.id)).toEqual([]);
    expect(store.inputs.tasksWithUndelivered()).toEqual([running.id]);
    expect(report.restartedTasks).toBe(1);
  });

  it("catches up the owner's DMs and the mapped channels from their latest ts, skipping ones with no history", async () => {
    const { recover, slack, store } = setup();
    store.events.record(ownerMessage({ eventId: "EvDm", ts: "100.000005" }));
    store.events.record(
      ownerMessage({
        eventId: "EvMapped",
        type: "app_mention",
        channel: "C0MAPPED",
        ts: "200.000007",
      }),
    );
    store.events.setDisposition("EvDm", "replied");
    store.events.setDisposition("EvMapped", "routed");

    const report = await recover(["C0MAPPED", "C0NEVERSEEN"]);

    expect(slack.catchUp.mock.calls.map(([target]) => target)).toEqual([
      { channel: "D0OWNER", threadTs: null, oldest: "100.000005" },
      { channel: "C0MAPPED", threadTs: null, oldest: "200.000007" },
    ]);
    expect(report).toMatchObject({
      caughtUpMessages: 2,
      conversationsWithoutHistory: ["C0NEVERSEEN"],
    });
  });

  it("catches up open task threads from their latest reply, or their root", async () => {
    const { recover, slack, store } = setup();
    const withReplies = createTaskIn(store, "running", "300.000001");
    const withoutReplies = createTaskIn(store, "waiting", "400.000001");
    const finished = createTaskIn(store, "done", "500.000001");
    for (const task of [withReplies, withoutReplies, finished]) {
      store.threads.claim({
        channel: "C0MAPPED",
        threadTs: task.originTs,
        taskId: task.id,
      });
    }
    store.events.record(
      ownerMessage({
        eventId: "EvReply",
        type: "app_mention",
        channel: "C0MAPPED",
        ts: "300.000009",
        threadTs: "300.000001",
      }),
    );
    store.events.setDisposition("EvReply", "task_input");

    await recover();

    const threadTargets = slack.catchUp.mock.calls
      .map(([target]) => target)
      .filter(({ threadTs }) => threadTs !== null);
    expect(threadTargets).toEqual([
      { channel: "C0MAPPED", threadTs: "300.000001", oldest: "300.000009" },
      { channel: "C0MAPPED", threadTs: "400.000001", oldest: "400.000001" },
    ]);
  });

  it("logs a conversation it can't read and moves on to the next", async () => {
    const { logger, recover, slack, store } = setup();
    store.events.record(ownerMessage({ eventId: "EvDm" }));
    store.events.record(
      ownerMessage({
        eventId: "EvMapped",
        channel: "C0MAPPED",
        type: "app_mention",
      }),
    );
    store.events.setDisposition("EvDm", "replied");
    store.events.setDisposition("EvMapped", "routed");
    slack.catchUp
      .mockRejectedValueOnce(new Error("not_in_channel"))
      .mockResolvedValueOnce({ fed: 2, failed: 1 });

    const report = await recover(["C0MAPPED"]);

    expect(slack.catchUp).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ caughtUpMessages: 2, failures: 2 });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "recovery: catching up on D0OWNER failed: not_in_channel",
    );
  });
});
