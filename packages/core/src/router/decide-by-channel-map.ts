import type { Repo } from "../repos/config.ts";
import { routeMessage } from "../repos/route-message.ts";
import type { Candidate } from "../store/candidates.ts";
import {
  type DecisionContext,
  type DecisionResult,
  decideReply,
  decideStartTask,
} from "./decide.ts";

export interface ChannelMapContext extends Omit<DecisionContext, "decidedBy"> {
  /** Channel ID -> Repo. */
  channelRepos: ReadonlyMap<string, Repo>;
}

const FALLBACK_REASON = "The router didn't decide, so the channel map did.";
const UNROUTABLE_REPLY =
  "I couldn't tell what to do with this. Mention me in a new message to start it as a task of its own.";

export const decideByChannelMap = (
  { channelRepos, ...context }: ChannelMapContext,
  candidate: Candidate,
): DecisionResult => {
  const decisionContext: DecisionContext = {
    ...context,
    decidedBy: "fallback",
  };
  const route = routeMessage(channelRepos, candidate);
  if (route.kind === "repo") {
    const started = decideStartTask(decisionContext, {
      candidateId: candidate.id,
      repo: route.repo.name,
      reason: FALLBACK_REASON,
    });
    if (started.isAccepted) return started;
  }
  return decideReply(decisionContext, {
    candidateId: candidate.id,
    text: route.kind === "reply" ? route.text : UNROUTABLE_REPLY,
    reason: FALLBACK_REASON,
  });
};
