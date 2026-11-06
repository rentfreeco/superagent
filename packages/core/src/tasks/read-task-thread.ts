import { TASK_THREAD_READ_MAX_LENGTH } from "../constants.ts";
import type { ThreadMessage } from "../slack/thread.ts";
import type { Task } from "../store/tasks.ts";
import { truncateText } from "../utils/truncate-text.ts";

export interface ThreadReader {
  fetchThread(channel: string, threadTs: string): Promise<ThreadMessage[]>;
}

export interface ReadTaskThreadOptions {
  threads: ThreadReader;
  task: Pick<Task, "originChannel" | "originTs">;
  ownerUserId: string;
}

const SEPARATOR = "\n\n";

const describeMessage = ({ fromSelf, text }: ThreadMessage): string =>
  `[${fromSelf ? "superagent" : "owner"}]\n${text}`;

const lengthAfter = (
  notices: readonly string[],
  shownLength: number,
): number => {
  const noticesLength = notices.join(SEPARATOR).length;
  if (noticesLength === 0) return shownLength;
  return shownLength === 0
    ? noticesLength
    : noticesLength + SEPARATOR.length + shownLength;
};

export const readTaskThread = async ({
  threads,
  task,
  ownerUserId,
}: ReadTaskThreadOptions): Promise<string> => {
  const messages = await threads.fetchThread(task.originChannel, task.originTs);
  const descriptions = messages
    .filter(({ fromSelf, user }) => fromSelf || user === ownerUserId)
    .map(describeMessage);
  const leftOutOthers = messages.length - descriptions.length;
  const noticesFor = (leftOutForLength: number): string[] => [
    ...(leftOutForLength > 0
      ? [`(${leftOutForLength} earlier messages left out for length.)`]
      : []),
    ...(leftOutOthers > 0
      ? [
          `(${leftOutOthers} messages from other people left out. Only the owner's messages and superagent's own are shown.)`,
        ]
      : []),
  ];

  let firstShownIndex = descriptions.length;
  let shownLength = 0;
  for (const [index, description] of [...descriptions.entries()].reverse()) {
    const nextShownLength =
      shownLength === 0
        ? description.length
        : description.length + SEPARATOR.length + shownLength;
    if (
      lengthAfter(noticesFor(index), nextShownLength) >
      TASK_THREAD_READ_MAX_LENGTH
    ) {
      break;
    }
    firstShownIndex = index;
    shownLength = nextShownLength;
  }

  const newest = descriptions.at(-1);
  if (firstShownIndex === descriptions.length && newest !== undefined) {
    const notices = noticesFor(descriptions.length - 1);
    const room =
      TASK_THREAD_READ_MAX_LENGTH -
      (notices.length === 0 ? 0 : lengthAfter(notices, 0) + SEPARATOR.length);
    return [...notices, truncateText(newest, room)].join(SEPARATOR);
  }
  return [
    ...noticesFor(firstShownIndex),
    ...descriptions.slice(firstShownIndex),
  ].join(SEPARATOR);
};
