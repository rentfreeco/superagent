import type { StartTask } from "./handle-message.ts";

export const acknowledgeTask: StartTask = ({ message, repo, store }) => {
  store.outbox.enqueue({
    dedupeKey: `ack:${message.eventId}`,
    channel: message.channel,
    threadTs: message.threadTs,
    message: {
      kind: "post",
      text: `Got it, this is for *${repo.name}* (\`${repo.github}\`). Running tasks isn't built yet, so that's all I can do for now.`,
    },
  });
};
