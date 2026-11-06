import { describe, expect, it } from "vitest";
import type { Repo } from "../repos/config.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import { openTestStore } from "../store/open-test-store.ts";
import {
  type DecisionContext,
  decideAttach,
  decideIgnore,
  decideReply,
  decideStartTask,
  decideStop,
} from "./decide.ts";
import { decideByChannelMap } from "./decide-by-channel-map.ts";
import { listTasks } from "./list-tasks.ts";
import { queueCandidate } from "./queue-candidate.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const message = (fields: Partial<InboundMessage>): InboundMessage => ({
  eventId: "EvDm",
  channel: "D0OWNER",
  ts: "100.000001",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "fix the flaky test in superagent",
  via: "dm",
  ...fields,
});

const setup = () => {
  const { store } = openTestStore();
  const context: DecisionContext = {
    store,
    repos: new Map([["superagent", superagentRepo]]),
    decidedBy: "router",
  };
  const queue = (fields: Partial<InboundMessage> = {}) => {
    const inbound = message(fields);
    store.events.record({
      eventId: inbound.eventId,
      type: inbound.via === "dm" ? "message" : "app_mention",
      channel: inbound.channel,
      ts: inbound.ts,
      threadTs: null,
      user: inbound.user,
      text: inbound.text,
    });
    queueCandidate({ message: inbound, store });
    const [candidate] = store.candidates.undecided().slice(-1);
    if (candidate === undefined) throw new Error("No candidate queued");
    return candidate;
  };
  const queuedPosts = () =>
    store.outbox.pending().map(({ threadTs, message: posted }) => ({
      threadTs,
      message: posted,
    }));
  return { context, queue, queuedPosts, store };
};

describe("decisions", () => {
  it("starts a task in the chosen repo from a DM, with the router's title, and settles the event", () => {
    const { context, queue, store } = setup();
    const candidate = queue();

    const result = decideStartTask(context, {
      candidateId: candidate.id,
      repo: "superagent",
      title: "Fix the flaky test",
      reason: "A DM asking for a fix in superagent.",
    });

    const [task] = store.tasks.withState(["queued"]);
    expect(result).toEqual({
      isAccepted: true,
      reply: `Started task ${task?.id} in superagent.`,
    });
    expect(task).toMatchObject({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "D0OWNER",
    });
    expect(store.decisions.forCandidate(candidate.id)).toMatchObject({
      outcome: "start_task",
      taskId: task?.id,
      reason: "A DM asking for a fix in superagent.",
      decidedBy: "router",
    });
    expect(store.events.get("EvDm")?.disposition).toBe("routed");
    expect(store.candidates.get(candidate.id)?.decidedAt).not.toBeNull();
  });

  it("refuses an unknown repo, or a thread a task already owns, and leaves the candidate open", () => {
    const { context, queue, store } = setup();
    const candidate = queue();

    expect(
      decideStartTask(context, {
        candidateId: candidate.id,
        repo: "nope",
        reason: "guess",
      }),
    ).toEqual({
      isAccepted: false,
      reply: "There is no repo named nope. Use one of: superagent.",
    });
    const task = store.tasks.create({
      title: "Other",
      repo: "superagent",
      originChannel: "D0OWNER",
      originTs: "100.000001",
    });
    store.threads.claim({
      channel: "D0OWNER",
      threadTs: "100.000001",
      taskId: task.id,
    });
    expect(
      decideStartTask(context, {
        candidateId: candidate.id,
        repo: "superagent",
        reason: "again",
      }).reply,
    ).toMatch(new RegExp(`already belongs to task ${task.id}`));
    expect(store.candidates.get(candidate.id)?.decidedAt).toBeNull();
    expect(store.events.get("EvDm")?.disposition).toBe("received");
  });

  it("decides each candidate once", () => {
    const { context, queue, queuedPosts } = setup();
    const candidate = queue();

    decideReply(context, {
      candidateId: candidate.id,
      text: "Which repo?",
      reason: "No repo named.",
    });

    expect(
      decideIgnore(context, { candidateId: candidate.id, reason: "late" }),
    ).toEqual({
      isAccepted: false,
      reply: `Candidate ${candidate.id} is already decided.`,
    });
    expect(queuedPosts()).toEqual([
      {
        threadTs: "100.000001",
        message: { kind: "post", text: "Which repo?" },
      },
    ]);
  });

  it("attaches a message to a task as a router input, and stops one in the candidate's thread", () => {
    const { context, queue, queuedPosts, store } = setup();
    const task = store.tasks.create({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "90.000001",
    });
    store.tasks.transition(task.id, "running");
    const attached = queue({ eventId: "EvAttach", text: "also the docs" });
    const stopping = queue({
      eventId: "EvStop",
      ts: "100.000002",
      threadTs: "100.000002",
    });

    decideAttach(context, {
      candidateId: attached.id,
      taskId: task.id,
      reason: "It names that task.",
    });
    expect(store.inputs.undelivered(task.id)).toEqual([
      expect.objectContaining({
        source: "router",
        ref: "EvAttach",
        text: expect.stringContaining("also the docs"),
      }),
    ]);
    decideStop(context, {
      candidateId: stopping.id,
      taskId: task.id,
      reason: "Asked to stop it.",
    });

    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(store.events.get("EvAttach")?.disposition).toBe("task_input");
    expect(store.events.get("EvStop")?.disposition).toBe("stopped_task");
    expect(queuedPosts()).toEqual([
      {
        threadTs: "100.000002",
        message: { kind: "post", text: expect.stringMatching(/^Stopped/) },
      },
    ]);
  });

  it("ignores a message and settles it as ignored", () => {
    const { context, queue, store } = setup();
    const candidate = queue({ text: "thanks!" });
    expect(
      decideIgnore(context, { candidateId: candidate.id, reason: "Thanks." })
        .isAccepted,
    ).toBe(true);
    expect(store.events.get("EvDm")?.disposition).toBe("ignored");
  });
});

describe("messages waiting in the thread a new task takes over", () => {
  it("passes them to the task in the same transaction, so restart recovery and the router leave them be", () => {
    const { context, queue, queuedPosts, store } = setup();
    const first = queue({ channel: "C0MAPPED", via: "mention" });
    const later = queue({
      eventId: "Ev2",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: "100.000001",
      text: "also fix the lint",
      via: "mention",
    });
    const elsewhere = queue({
      eventId: "EvElsewhere",
      channel: "C0MAPPED",
      ts: "200.000001",
      threadTs: "200.000001",
      text: "update the README",
      via: "mention",
    });

    const started = decideStartTask(context, {
      candidateId: first.id,
      repo: "superagent",
      reason: "A request.",
    });

    const [task] = store.tasks.withState(["queued"]);
    expect(started.reply).toBe(
      `Started task ${task?.id} in superagent, and passed it the 1 later message(s) waiting in its thread.`,
    );
    expect(
      store.inputs
        .unread(task?.id ?? "")
        .map(({ ref, text }) => ({ ref, text })),
    ).toEqual([
      { ref: "EvDm", text: "fix the flaky test in superagent" },
      { ref: "Ev2", text: "also fix the lint" },
    ]);
    expect(store.decisions.forCandidate(later.id)).toMatchObject({
      outcome: "attach",
      taskId: task?.id,
      decidedBy: "router",
    });
    expect(store.candidates.get(elsewhere.id)?.decidedAt).toBeNull();
    expect(store.events.unfinished().map(({ eventId }) => eventId)).toEqual([
      "EvElsewhere",
    ]);
    expect(queuedPosts()).toEqual([]);
    expect(
      decideStartTask(context, {
        candidateId: later.id,
        repo: "superagent",
        reason: "Another request.",
      }).reply,
    ).toBe(`Candidate ${later.id} is already decided.`);
  });

  it("does the same when the channel map decides, and stops the task for a waiting stop", () => {
    const { context, queue, store } = setup();
    const first = queue({ channel: "C0MAPPED", via: "mention" });
    queue({
      eventId: "Ev2",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: "100.000001",
      text: "stop",
      via: "mention",
    });

    decideByChannelMap(
      { ...context, channelRepos: new Map([["C0MAPPED", superagentRepo]]) },
      first,
    );

    const [task] = store.tasks.withState(["stopped"]);
    expect(task).toBeDefined();
    expect(store.events.get("Ev2")?.disposition).toBe("stopped_task");
  });

  it("leaves a message another task handed back alone", () => {
    const { context, queue, store } = setup();
    const first = queue({ channel: "C0MAPPED", via: "mention" });
    store.events.record({
      eventId: "EvHandedBack",
      type: "message",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: "100.000001",
      user: "U0OWNER",
      text: "what's on my calendar?",
    });
    const handedBack = store.candidates.add({
      ...message({
        eventId: "EvHandedBack",
        channel: "C0MAPPED",
        ts: "100.000002",
        threadTs: "100.000001",
        via: "thread",
      }),
      handedBackBy: store.tasks.create({
        title: "Earlier",
        repo: "superagent",
        originChannel: "C0MAPPED",
        originTs: "50.000001",
      }).id,
      handBackReason: "Not about this task.",
    });

    decideStartTask(context, {
      candidateId: first.id,
      repo: "superagent",
      reason: "A request.",
    });

    expect(store.candidates.get(handedBack?.id ?? 0)?.decidedAt).toBeNull();
  });
});

describe("decisions for a handed-back message", () => {
  const handBack = (
    store: ReturnType<typeof setup>["store"],
    taskId: string,
    fields: Partial<InboundMessage> = {},
  ) => {
    const handedBack = store.candidates.add({
      ...message({
        eventId: "EvOffTopic",
        channel: "C0MAPPED",
        ts: "100.000002",
        threadTs: "100.000001",
        via: "thread",
        ...fields,
      }),
      handedBackBy: taskId,
      handBackReason: "Not about this task.",
    });
    if (handedBack === undefined) throw new Error("Not handed back");
    return handedBack;
  };

  it("won't start a task in the thread of the task that handed it back, or attach it back to that task", () => {
    const { context, queue, store } = setup();
    const origin = queue({ channel: "C0MAPPED", via: "mention" });
    decideStartTask(context, {
      candidateId: origin.id,
      repo: "superagent",
      reason: "A request.",
    });
    const [task] = store.tasks.withState(["queued"]);
    if (task === undefined) throw new Error("No task started");
    store.events.record({
      eventId: "EvOffTopic",
      type: "message",
      channel: "C0MAPPED",
      ts: "100.000002",
      threadTs: "100.000001",
      user: "U0OWNER",
      text: "fix the flaky test in superagent",
    });
    const handedBack = handBack(store, task.id);

    expect(
      decideStartTask(context, {
        candidateId: handedBack.id,
        repo: "superagent",
        reason: "A new request.",
      }),
    ).toEqual({
      isAccepted: false,
      reply: `This message is in task ${task.id}'s thread, so no task can start from it. Reply asking the owner to send it as a new message, or attach it to the task it is about.`,
    });
    expect(
      decideAttach(context, {
        candidateId: handedBack.id,
        taskId: task.id,
        reason: "It is about this task after all.",
      }).isAccepted,
    ).toBe(false);
    expect(
      decideReply(context, {
        candidateId: handedBack.id,
        text: "Send that as a new message and I'll start it.",
        reason: "A new request in another task's thread.",
      }).isAccepted,
    ).toBe(true);
    expect(store.events.get("EvOffTopic")?.disposition).toBe("replied");
  });

  it("refuses to attach a message the router already gave one task to another", () => {
    const { context, queue, store } = setup();
    const first = store.tasks.create({
      title: "First",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "300.000001",
    });
    const second = store.tasks.create({
      title: "Second",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "400.000001",
    });
    const dm = queue();
    decideAttach(context, {
      candidateId: dm.id,
      taskId: first.id,
      reason: "It names the first task.",
    });
    const handedBack = handBack(store, first.id, {
      eventId: dm.eventId,
      channel: dm.channel,
      ts: dm.ts,
      threadTs: dm.threadTs,
      via: "dm",
    });

    expect(
      decideAttach(context, {
        candidateId: handedBack.id,
        taskId: second.id,
        reason: "Maybe the second one.",
      }),
    ).toEqual({
      isAccepted: false,
      reply:
        "This message was already passed to a task, which handed it back. Reply, start a task, or ignore it.",
    });
    expect(store.inputs.unread(second.id)).toEqual([]);
  });
});

describe("decideByChannelMap", () => {
  it("starts a task for a mention in a mapped channel, and answers a DM as before", () => {
    const { context, queue, queuedPosts, store } = setup();
    const channelRepos = new Map([["C0MAPPED", superagentRepo]]);
    const mention = queue({
      eventId: "EvMention",
      channel: "C0MAPPED",
      via: "mention",
    });
    const dm = queue({
      eventId: "EvDm2",
      ts: "100.000003",
      threadTs: "100.000003",
    });

    decideByChannelMap({ ...context, channelRepos }, mention);
    decideByChannelMap({ ...context, channelRepos }, dm);

    expect(store.decisions.forCandidate(mention.id)).toMatchObject({
      outcome: "start_task",
      decidedBy: "fallback",
    });
    expect(store.decisions.forCandidate(dm.id)).toMatchObject({
      outcome: "reply",
      decidedBy: "fallback",
    });
    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: expect.stringContaining("DMs don't map to a repo"),
    });
  });

  it("replies when it can't start a task, so a candidate always gets a decision", () => {
    const { context, queue, store } = setup();
    const channelRepos = new Map([["C0MAPPED", superagentRepo]]);
    const owner = store.tasks.create({
      title: "Owner",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "90.000001",
    });
    store.threads.claim({
      channel: "C0MAPPED",
      threadTs: "90.000001",
      taskId: owner.id,
    });
    const handedBack = queue({
      eventId: "EvThread",
      channel: "C0MAPPED",
      threadTs: "90.000001",
      via: "thread",
    });

    expect(
      decideByChannelMap({ ...context, channelRepos }, handedBack).isAccepted,
    ).toBe(true);
    expect(store.decisions.forCandidate(handedBack.id)?.outcome).toBe("reply");
  });
});

describe("listTasks", () => {
  it("lists open tasks, or all of them, one line each", () => {
    const { store } = setup();
    expect(listTasks(store, "open")).toBe("There are no open tasks.");
    const task = store.tasks.create({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "90.000001",
    });
    store.tasks.transition(task.id, "running");
    store.tasks.transition(task.id, "done");

    expect(listTasks(store, "open")).toBe("There are no open tasks.");
    expect(listTasks(store, "all")).toBe(
      `- ${task.id} [done] Fix the flaky test, repo superagent, thread C0MAPPED/90.000001`,
    );
  });
});
