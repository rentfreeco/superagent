import { pullRequestInputSubject } from "../github/pull-request-input-subject.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { Store } from "../store/open-store.ts";
import type { NewOutboxEntry } from "../store/outbox.ts";

export interface TaskPullRequest {
  /** owner/name */
  repository: string;
  number: number;
}

export interface MessageReaction {
  /** Keys the outbox entry, such as ack or done. */
  purpose: string;
  slackName: string;
  gitHubContent: string;
  isRemoval: boolean;
}

/**
 * The outbox entry that puts a reaction on, or takes one off, the message
 * behind an input: a Slack message by its event, or a pull request comment
 * on GitHub. Undefined when there is no message, or nothing that takes one.
 */
export const messageReactionEntry = (
  store: Pick<Store, "events">,
  input: TaskInput,
  pullRequest: TaskPullRequest | undefined,
  { purpose, slackName, gitHubContent, isRemoval }: MessageReaction,
): NewOutboxEntry | undefined => {
  if (input.ref === null) return undefined;
  const dedupeKey = `${purpose}:${input.ref}`;
  if (input.source === "github") {
    const subject = pullRequestInputSubject(input.ref);
    if (subject === undefined || pullRequest === undefined) return undefined;
    return {
      dedupeKey,
      channel: `github:${pullRequest.repository}`,
      threadTs: String(pullRequest.number),
      message: {
        kind: isRemoval ? "github_reaction_removal" : "github_reaction",
        repository: pullRequest.repository,
        ...subject,
        content: gitHubContent,
      },
    };
  }
  const event = store.events.get(input.ref);
  if (event === undefined || event.channel === null || event.ts === null) {
    return undefined;
  }
  return {
    dedupeKey,
    channel: event.channel,
    threadTs: null,
    message: {
      kind: isRemoval ? "reaction_removal" : "reaction",
      name: slackName,
      timestamp: event.ts,
    },
  };
};
