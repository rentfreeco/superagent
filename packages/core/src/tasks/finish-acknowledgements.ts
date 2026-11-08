import {
  GITHUB_DONE_REACTION,
  TASK_ACK_REACTION,
  TASK_DONE_REACTION,
} from "../constants.ts";
import type { Store } from "../store/open-store.ts";
import {
  messageReactionEntry,
  type TaskPullRequest,
} from "./message-reactions.ts";

export interface FinishAcknowledgementsOptions {
  store: Pick<Store, "transaction" | "inputs" | "events" | "outbox">;
  inputIds: readonly number[];
  pullRequest?: TaskPullRequest | undefined;
}

/**
 * Swaps 👀 for a done reaction on the messages a turn finished: ✅ in
 * Slack, 👍 on GitHub, which has no check mark. Queued in that order, so
 * the outbox takes 👀 off before it puts the other on.
 */
export const finishAcknowledgements = ({
  store,
  inputIds,
  pullRequest,
}: FinishAcknowledgementsOptions): number =>
  store.transaction(() => {
    let finishedCount = 0;
    for (const inputId of inputIds) {
      const input = store.inputs.get(inputId);
      if (input === undefined) continue;
      const removal = messageReactionEntry(store, input, pullRequest, {
        purpose: "unack",
        slackName: TASK_ACK_REACTION,
        gitHubContent: TASK_ACK_REACTION,
        isRemoval: true,
      });
      const done = messageReactionEntry(store, input, pullRequest, {
        purpose: "done",
        slackName: TASK_DONE_REACTION,
        gitHubContent: GITHUB_DONE_REACTION,
        isRemoval: false,
      });
      if (removal === undefined || done === undefined) continue;
      store.outbox.enqueue(removal);
      if (store.outbox.enqueue(done) !== undefined) finishedCount += 1;
    }
    return finishedCount;
  });
