import { loadConfig, type Repo } from "@repo/core/repos";
import { SlackGateway } from "@repo/core/slack";
import { acknowledgeTask } from "./acknowledge-task.ts";
import { CONFIG_PATH } from "./constants.ts";
import { parseEnvironment } from "./environment.ts";
import { createMessageHandler } from "./handle-message.ts";

const describeChannels = (channelRepos: ReadonlyMap<string, Repo>): string =>
  [...channelRepos]
    .map(([channelId, repo]) => `${channelId} → ${repo.name}`)
    .join(", ") || "none mapped";

const main = async (): Promise<void> => {
  const environment = parseEnvironment(process.env);
  const channelRepos = await loadConfig(CONFIG_PATH);
  const slack = await SlackGateway.connect({
    botToken: environment.slackBotToken,
    appToken: environment.slackAppToken,
    ownerUserId: environment.slackOwnerId,
    logLevel: environment.logLevel,
    onMessage: createMessageHandler({
      channelRepos,
      startTask: acknowledgeTask,
    }),
  });
  console.log(
    `superagent: connected as ${slack.identity.userId}, listening to ${environment.slackOwnerId}. Channels: ${describeChannels(channelRepos)}`,
  );

  const disconnect = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`superagent: ${signal} received, disconnecting`);
    await slack.close();
    process.exit();
  };
  process.once("SIGINT", disconnect);
  process.once("SIGTERM", disconnect);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
