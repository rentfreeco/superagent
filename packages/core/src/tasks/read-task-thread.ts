import { TASK_THREAD_READ_MAX_LENGTH } from "../constants.ts";
import type { ThreadMessage } from "../slack/thread.ts";
import type { Task } from "../store/tasks.ts";

export interface ThreadReader {
  fetchThread(channel: string, threadTs: string): Promise<ThreadMessage[]>;
}

export interface ReadTaskThreadOptions {
  threads: ThreadReader;
  task: Pick<Task, "originChannel" | "originTs">;
  ownerUserId: string;
}

const describeMessage = ({ fromSelf, text }: ThreadMessage): string =>
  `[${fromSelf ? "superagent" : "owner"}]\n${text}`;

export const readTaskThread = async ({
  threads,
  task,
  ownerUserId,
}: ReadTaskThreadOptions): Promise<string> => {
  const messages = await threads.fetchThread(task.originChannel, task.originTs);
  const visibleMessages = messages.filter(
    ({ fromSelf, user }) => fromSelf || user === ownerUserId,
  );
  const shownMessages: string[] = [];
  let shownLength = 0;
  for (const message of visibleMessages.toReversed()) {
    const description = describeMessage(message);
    if (
      shownMessages.length > 0 &&
      shownLength + description.length > TASK_THREAD_READ_MAX_LENGTH
    ) {
      break;
    }
    shownMessages.unshift(description);
    shownLength += description.length;
  }
  const leftOutForLength = visibleMessages.length - shownMessages.length;
  const leftOutOthers = messages.length - visibleMessages.length;
  return [
    ...(leftOutForLength > 0
      ? [`(${leftOutForLength} earlier messages left out for length.)`]
      : []),
    ...(leftOutOthers > 0
      ? [
          `(${leftOutOthers} messages from other people left out. Only the owner's messages and superagent's own are shown.)`,
        ]
      : []),
    ...shownMessages,
  ].join("\n\n");
};
