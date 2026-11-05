import type { StartTask } from "./handle-message.ts";

export const acknowledgeTask: StartTask = async ({ message, repo, slack }) => {
  await slack.reply(
    message,
    `Got it, this is for *${repo.name}* (\`${repo.github}\`). Running tasks isn't built yet, so that's all I can do for now.`,
  );
};
