import type { Repo } from "../repos/config.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import type { Candidate } from "../store/candidates.ts";
import type { Decision, DecisionOutcome } from "../store/decisions.ts";
import type { EventDisposition } from "../store/events.ts";
import type { Store } from "../store/open-store.ts";
import { startTask } from "../tasks/start-task.ts";
import { stopTask } from "../tasks/stop-task.ts";

export interface DecisionContext {
  store: Pick<
    Store,
    | "transaction"
    | "candidates"
    | "decisions"
    | "events"
    | "tasks"
    | "threads"
    | "inputs"
    | "outbox"
  >;
  /** Repo name -> Repo. */
  repos: ReadonlyMap<string, Repo>;
  decidedBy: Decision["decidedBy"];
}

export interface DecisionResult {
  isAccepted: boolean;
  reply: string;
}

interface Settlement {
  outcome: DecisionOutcome;
  taskId: string | null;
  disposition: EventDisposition;
  reply: string;
}

export interface StartTaskDecision {
  candidateId: number;
  repo: string;
  title?: string | undefined;
  reason: string;
}

export interface ReplyDecision {
  candidateId: number;
  text: string;
  reason: string;
}

export interface TaskDecision {
  candidateId: number;
  taskId: string;
  reason: string;
}

export interface IgnoreDecision {
  candidateId: number;
  reason: string;
}

const refused = (reply: string): DecisionResult => ({
  isAccepted: false,
  reply,
});

const settle = (
  { store, decidedBy }: DecisionContext,
  candidateId: number,
  reason: string,
  decide: (candidate: Candidate) => Settlement | string,
): DecisionResult =>
  store.transaction(() => {
    const candidate = store.candidates.get(candidateId);
    if (candidate === undefined)
      return refused(`There is no candidate ${candidateId}.`);
    if (candidate.decidedAt !== null) {
      return refused(`Candidate ${candidateId} is already decided.`);
    }
    const settlement = decide(candidate);
    if (typeof settlement === "string") return refused(settlement);
    store.decisions.add({
      candidateId,
      outcome: settlement.outcome,
      taskId: settlement.taskId,
      reason,
      decidedBy,
    });
    store.events.setDisposition(candidate.eventId, settlement.disposition);
    store.candidates.markDecided(candidateId);
    return { isAccepted: true, reply: settlement.reply };
  });

const toMessage = (candidate: Candidate): InboundMessage => ({
  eventId: candidate.eventId,
  channel: candidate.channel,
  ts: candidate.ts,
  threadTs: candidate.threadTs,
  user: candidate.user,
  text: candidate.text,
  via: candidate.via,
});

export const decideStartTask = (
  context: DecisionContext,
  { candidateId, repo: repoName, title, reason }: StartTaskDecision,
): DecisionResult =>
  settle(context, candidateId, reason, (candidate) => {
    const repo = context.repos.get(repoName);
    if (repo === undefined) {
      return `There is no repo named ${repoName}. Use one of: ${[...context.repos.keys()].join(", ")}.`;
    }
    const owner = context.store.threads.owner(
      candidate.channel,
      candidate.threadTs,
    );
    if (owner?.taskId) {
      return `This thread already belongs to task ${owner.taskId}. Attach the message to it, or reply.`;
    }
    startTask({
      message: toMessage(candidate),
      repo,
      store: context.store,
      title,
    });
    const taskId =
      context.store.threads.owner(candidate.channel, candidate.threadTs)
        ?.taskId ?? null;
    return {
      outcome: "start_task",
      taskId,
      disposition: "routed",
      reply: `Started task ${taskId} in ${repo.name}.`,
    };
  });

export const decideReply = (
  context: DecisionContext,
  { candidateId, text, reason }: ReplyDecision,
): DecisionResult =>
  settle(context, candidateId, reason, (candidate) => {
    if (!text.trim()) return "A reply needs text.";
    context.store.outbox.enqueue({
      dedupeKey: `reply:${candidate.eventId}`,
      channel: candidate.channel,
      threadTs: candidate.threadTs,
      message: { kind: "post", text: text.trim() },
    });
    return {
      outcome: "reply",
      taskId: null,
      disposition: "replied",
      reply: "Replied in the message's thread.",
    };
  });

export const decideAttach = (
  context: DecisionContext,
  { candidateId, taskId, reason }: TaskDecision,
): DecisionResult =>
  settle(context, candidateId, reason, (candidate) => {
    if (context.store.tasks.get(taskId) === undefined) {
      return `There is no task ${taskId}.`;
    }
    if (candidate.handedBackBy === taskId) {
      return `Task ${taskId} handed this message back. Attach it elsewhere, or decide another way.`;
    }
    context.store.inputs.add({
      taskId,
      source: "router",
      ref: candidate.eventId,
      text: `The owner wrote this elsewhere, and it is about this task: ${candidate.text}`,
    });
    return {
      outcome: "attach",
      taskId,
      disposition: "task_input",
      reply: `Passed the message to task ${taskId}.`,
    };
  });

export const decideStop = (
  context: DecisionContext,
  { candidateId, taskId, reason }: TaskDecision,
): DecisionResult =>
  settle(context, candidateId, reason, (candidate) => {
    if (context.store.tasks.get(taskId) === undefined) {
      return `There is no task ${taskId}.`;
    }
    stopTask({
      store: context.store,
      taskId,
      eventId: candidate.eventId,
      channel: candidate.channel,
      threadTs: candidate.threadTs,
    });
    return {
      outcome: "stop",
      taskId,
      disposition: "stopped_task",
      reply: `Stopped task ${taskId}, and posted the confirmation.`,
    };
  });

export const decideIgnore = (
  context: DecisionContext,
  { candidateId, reason }: IgnoreDecision,
): DecisionResult =>
  settle(context, candidateId, reason, () => ({
    outcome: "ignore",
    taskId: null,
    disposition: "ignored",
    reply: "Ignored.",
  }));
