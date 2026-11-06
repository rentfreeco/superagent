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
