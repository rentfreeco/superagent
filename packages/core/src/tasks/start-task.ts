import { TASK_TITLE_MAX_LENGTH } from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import type { Store } from "../store/open-store.ts";
import { truncateText } from "../utils/truncate-text.ts";

export interface TaskRequestStore extends Pick<
  Store,
  "tasks" | "threads" | "inputs" | "outbox"
> {}

export interface TaskRequest {
  message: InboundMessage;
  repo: Repo;
  store: TaskRequestStore;
  /** A title chosen for the task; the message's first line otherwise. */
  title?: string | undefined;
}

const UNTITLED_TASK = "Untitled request";

const titleFromRequest = (text: string): string => {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return firstLine === undefined
    ? UNTITLED_TASK
    : truncateText(firstLine, TASK_TITLE_MAX_LENGTH);
};

export const startTask = ({
  message,
  repo,
  store,
  title,
}: TaskRequest): undefined => {
  const task = store.tasks.create({
    title: title?.trim()
      ? truncateText(title.trim(), TASK_TITLE_MAX_LENGTH)
      : titleFromRequest(message.text),
    repo: repo.name,
    originChannel: message.channel,
    originTs: message.threadTs,
  });
  const owner = store.threads.claim({
    channel: message.channel,
    threadTs: message.threadTs,
    taskId: task.id,
  });
  if (owner.taskId !== task.id) {
    throw new Error(
      `Thread ${message.channel}/${message.threadTs} already belongs to task ${owner.taskId}.`,
    );
  }
  store.inputs.add({
    taskId: task.id,
    source: "slack",
    ref: message.eventId,
    text: message.text,
  });
};
