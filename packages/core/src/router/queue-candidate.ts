import type { InboundMessage } from "../slack/inbound.ts";
import type { Store } from "../store/open-store.ts";

export interface CandidateRequest {
  message: InboundMessage;
  store: Pick<Store, "candidates">;
}

export const queueCandidate = ({ message, store }: CandidateRequest): void => {
  store.candidates.add({
    eventId: message.eventId,
    channel: message.channel,
    ts: message.ts,
    threadTs: message.threadTs,
    user: message.user,
    text: message.text,
    via: message.via,
    handedBackBy: null,
    handBackReason: null,
  });
};
