import { TASK_ACK_REACTION } from "../constants.ts";
import type { Store } from "../store/open-store.ts";
import {
  messageReactionEntry,
  type TaskPullRequest,
} from "./message-reactions.ts";

export interface AcknowledgeMessagesOptions {
  store: Pick<Store, "transaction" | "inputs" | "events" | "outbox">;
  taskId: string;
  /** The task's pull request, for 👀 on its comments on GitHub. */
  pullRequest?: TaskPullRequest | undefined;
}

/** Queues 👀 on each message the worker was given and hasn't finished, in Slack or on GitHub. */
export const acknowledgeMessages = ({
  store,
  taskId,
  pullRequest,
}: AcknowledgeMessagesOptions): number =>
  store.transaction(() => {
    let acknowledgedCount = 0;
    for (const input of store.inputs.unread(taskId)) {
      if (input.deliveredAt === null) continue;
      const entry = messageReactionEntry(store, input, pullRequest, {
        purpose: "ack",
        slackName: TASK_ACK_REACTION,
        gitHubContent: TASK_ACK_REACTION,
        isRemoval: false,
      });
      if (entry !== undefined && store.outbox.enqueue(entry) !== undefined) {
        acknowledgedCount += 1;
      }
    }
    return acknowledgedCount;
  });
